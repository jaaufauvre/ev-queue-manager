import { Color, Logger } from './logger'
import cron from 'node-cron'
import {
  default as makeWASocket,
  WASocket,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  Browsers,
  WAMessage,
  MessageUpsertType,
} from '@whiskeysockets/baileys'

interface QueueEntry {
  id: string
  joined: number
}

let GROUP_QUEUES: Record<string, QueueEntry[]> = {}

// Main entrypoint
;(async () => {
  Logger.info(Color.Yellow, '🤖 Starting ...')

  // Schedule daily queue reset at 6am Dublin Time
  cron.schedule(
    '0 6 * * *',
    () => {
      Logger.info(Color.Yellow, '🕓 Scheduled queue reset')
      GROUP_QUEUES = {}
    },
    { timezone: 'Europe/Dublin' },
  )

  let attempt = 0
  const delay = 5000
  while (true) {
    attempt++
    Logger.info(`Attempt ${attempt} at starting socket`)
    try {
      await start()
      Logger.info('Start returned, will retry ...')
    } catch (err) {
      Logger.error(`Attempt ${attempt} failed:`, err)
    }
    Logger.info(`Waiting ${delay}ms before retrying ...`)
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
})()

async function start() {
  try {
    // Authentication info
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    // Fetch the exact WA Web version tuple that WhatsApp’s servers expect
    const { version, isLatest, error } = await fetchLatestWaWebVersion({})
    if (error) {
      Logger.error(`Couldn't fetch the WA version`)
      throw error
    }
    Logger.info(
      `Using WA Web version ${version.join('.')}`,
      isLatest ? '(up-to-date)' : '(not latest?)',
    )

    const socket = makeWASocket({
      version,
      browser: Browsers.macOS('Chrome'),
      auth: state,
      printQRInTerminal: true,
    })

    await new Promise((_, reject) => {
      socket.ev.on('creds.update', saveCreds)
      socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
        if (connection === 'close') {
          Logger.error(`Connection was closed`)
          const error =
            (lastDisconnect && lastDisconnect.error) ||
            new Error('Connection closed')
          reject(error)
        }
        if (connection === 'open') {
          Logger.info('✅  Connected!')
        }
      })
      socket.ev.on('messages.upsert', async (m) => {
        await processUserMessage(m, socket)
      })
    })
  } catch (err) {
    // Log any startup errors and rethrow (to be caught by the retry loop)
    Logger.error(err)
    throw err
  }
}

async function processUserMessage(
  m: {
    messages: WAMessage[]
    type: MessageUpsertType
    requestId?: string
  },
  socket: WASocket,
) {
  if (!m.messages || m.messages.length == 0) {
    Logger.info('No messages, ignoring')
    return
  }
  const msg = m.messages[0]
  if (!msg.message) {
    Logger.info('No message, ignoring')
    return
  }
  Logger.info('Message: ' + JSON.stringify(msg))
  if (msg.key.fromMe) {
    Logger.info('Own message, ignoring')
    return
  }
  const userName = msg.pushName
  if (!userName || userName.length === 0) {
    Logger.info('No userName name, ignoring')
    return
  }
  const text =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.ephemeralMessage?.message?.conversation ||
    msg.message.ephemeralMessage?.message?.extendedTextMessage?.text
  if (!text?.startsWith('/')) {
    Logger.info('Not a command, ignoring')
    return
  }
  const groupId = msg.key.remoteJid
  if (!groupId) {
    Logger.info('Not from a group, ignoring')
    return
  }
  Logger.info(Color.Green, `Command: ${text}`)
  Logger.info(Color.Green, `User: ${userName}`)
  Logger.info(Color.Green, `Group: ${groupId}`)
  await handleCommand(groupId, socket, text, userName)
}

async function handleCommand(
  groupId: string,
  socket: WASocket,
  command: string,
  username: string,
) {
  switch (command.toLowerCase().trim()) {
    case '/help':
      return replyInGroup(
        groupId,
        socket,
        `Available commands:
* \`/help\` – View the command menu
* \`/join\` – Enter the queue
* \`/leave\` – Exit the queue
* \`/queue\` – See the current queue`,
      )

    case '/join':
      if (!isUserInQueue(groupId, username)) {
        addUserToQueue(groupId, username)
        await replyInGroup(groupId, socket, `${username} joined the queue`)
      } else {
        await replyInGroup(
          groupId,
          socket,
          `${username}, you're already in the queue`,
        )
      }
      await sendQueue(groupId, socket)
      break

    case '/leave':
      if (!isUserInQueue(groupId, username)) {
        await replyInGroup(
          groupId,
          socket,
          `${username}, you're not in the queue`,
        )
      } else {
        removeUserFromQueue(groupId, username)
        await replyInGroup(groupId, socket, `${username} left the queue`)
      }
      await sendQueue(groupId, socket)
      break

    case '/queue':
      return sendQueue(groupId, socket)

    default:
      return replyInGroup(
        groupId,
        socket,
        `Unknown command. Type \`/help\` for the list of commands.`,
      )
  }
}

function getGroupQueue(groupId: string) {
  if (!GROUP_QUEUES[groupId]) {
    GROUP_QUEUES[groupId] = []
  }
  return GROUP_QUEUES[groupId]
}

function setGroupQueue(groupId: string, queue: QueueEntry[]) {
  GROUP_QUEUES[groupId] = queue
}

function isUserInQueue(groupId: string, username: string) {
  return getGroupQueue(groupId).find((q) => q.id === username)
}

function addUserToQueue(groupId: string, username: string) {
  getGroupQueue(groupId).push({ id: username, joined: Date.now() })
}

function removeUserFromQueue(groupId: string, username: string) {
  const queue = getGroupQueue(groupId)
  setGroupQueue(
    groupId,
    queue.filter((q) => q.id !== username),
  )
}

function logQueue(groupId: string) {
  Logger.info('Queue: ' + JSON.stringify(getGroupQueue(groupId)))
}

async function sendQueue(groupId: string, client: WASocket) {
  logQueue(groupId)
  const list =
    getGroupQueue(groupId)
      .map((q, i) => `${i + 1}. ${q.id}`)
      .join('\n') || '—'
  return replyInGroup(groupId, client, `Queue:\n${list}`)
}

async function replyInGroup(groupId: string, client: WASocket, text: string) {
  await client.sendMessage(groupId, { text })
}
