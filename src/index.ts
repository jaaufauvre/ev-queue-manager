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
  proto,
} from '@whiskeysockets/baileys'
import IMessageKey = proto.IMessageKey

interface QueueEntry {
  userId: string
  username: string
  joined: number
}

let GROUP_QUEUES: Record<string, QueueEntry[]> = {}
const PROCESSED_MESSAGES = new Set()

// Main entrypoint
;(async () => {
  Logger.setDebug(false)
  Logger.info(Color.Yellow, '🤖 Starting ...')

  // Schedule daily queue reset at 6am Dublin Time
  cron.schedule(
    '0 6 * * *',
    () => {
      Logger.info(Color.Yellow, '🕓 Scheduled queue reset')
      GROUP_QUEUES = {}
      PROCESSED_MESSAGES.clear()
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
    Logger.debug('No messages, ignoring')
    return
  }
  if (m.type != 'notify') {
    Logger.debug('Not new messages, ignoring')
    return
  }
  for (const msg of m.messages) {
    if (!msg.message) {
      Logger.debug('No message, ignoring')
      return
    }
    const messageKey = msg.key
    if (!messageKey) {
      Logger.debug('No key for message, ignoring')
      return
    }
    const groupId = msg.key.remoteJid
    if (!groupId) {
      Logger.debug('Not from a group, ignoring')
      return
    }
    Logger.debug('Message: ' + JSON.stringify(msg))
    if (msg.key.fromMe) {
      Logger.debug('Own message, ignoring')
      return
    }
    const username = msg.pushName
    if (!username || username.length === 0) {
      Logger.debug('No user name, ignoring')
      return
    }
    const userId = msg.key.participant
    if (!userId || userId.length === 0) {
      Logger.debug('No user ID, ignoring')
      return
    }
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.ephemeralMessage?.message?.conversation ||
      msg.message.ephemeralMessage?.message?.extendedTextMessage?.text
    if (!text?.startsWith('/')) {
      Logger.debug('Not a command, ignoring')
      return
    }
    const uniqueId = `${groupId}|${messageKey.id}`
    if (PROCESSED_MESSAGES.has(uniqueId)) {
      Logger.debug('Message ID already processed, ignoring')
      return
    }
    PROCESSED_MESSAGES.add(uniqueId)
    Logger.info(Color.Green, `Command: ${text}`)
    Logger.info(Color.Green, `Username: ${username}`)
    Logger.info(Color.Green, `User ID: ${userId}`)
    Logger.info(Color.Green, `Group ID: ${groupId}`)
    await handleCommand(groupId, messageKey, socket, text, userId, username)
  }
}

async function handleCommand(
  groupId: string,
  messageKey: IMessageKey,
  socket: WASocket,
  command: string,
  userId: string,
  username: string,
) {
  switch (command.toLowerCase().trim()) {
    case '/help':
      await replyInGroup(
        groupId,
        socket,
        `Available commands:
* \`/help\` – View the command menu
* \`/join\` – Enter the queue
* \`/leave\` – Exit the queue
* \`/queue\` – Display the queue`,
      )
      await reactInGroup(groupId, messageKey, socket, '🆘')
      break

    case '/join':
      if (!isUserInQueue(groupId, userId)) {
        addUserToQueue(groupId, userId, username)
        await replyInGroup(
          groupId,
          socket,
          `${username} joined the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, messageKey, socket, '👍')
      } else {
        await replyInGroup(
          groupId,
          socket,
          `${username}, you're already in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, messageKey, socket, '❌')
      }
      break

    case '/leave':
      if (!isUserInQueue(groupId, userId)) {
        await replyInGroup(
          groupId,
          socket,
          `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, messageKey, socket, '❌')
      } else {
        removeUserFromQueue(groupId, userId)
        await replyInGroup(
          groupId,
          socket,
          `${username} left the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, messageKey, socket, '👋')
      }
      break

    case '/queue':
      await replyInGroup(
        groupId,
        socket,
        `Queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, messageKey, socket, '👀')
      break

    default:
      await replyInGroup(
        groupId,
        socket,
        `Unknown command. Type \`/help\` for the list of commands.`,
      )
      await reactInGroup(groupId, messageKey, socket, '❌')
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

function isUserInQueue(groupId: string, userId: string) {
  return getGroupQueue(groupId).find((entry) => entry.userId === userId)
}

function addUserToQueue(groupId: string, userId: string, username: string) {
  getGroupQueue(groupId).push({
    userId: userId,
    username: username,
    joined: Date.now(),
  })
}

function removeUserFromQueue(groupId: string, userId: string) {
  const queue = getGroupQueue(groupId)
  setGroupQueue(
    groupId,
    queue.filter((entry) => entry.userId !== userId),
  )
}

function userIdToMention(userId: string): string {
  const numberPart = userId.split('@')[0]
  return `@${numberPart}`
}

function logQueue(groupId: string) {
  Logger.info(Color.Yellow, 'Queue: ' + JSON.stringify(getGroupQueue(groupId)))
}

function formatQueueWithMentions(groupId: string) {
  logQueue(groupId)
  return (
    getGroupQueue(groupId)
      .map((entry, i) => `${i + 1}. ${userIdToMention(entry.userId)}`)
      .join('\n') || '—'
  )
}

function getQueueMentions(groupId: string): string[] {
  return getGroupQueue(groupId).map((entry) => entry.userId)
}

async function replyInGroup(
  groupId: string,
  socket: WASocket,
  text: string,
  mentions: string[] = [],
) {
  await socket.sendMessage(
    groupId,
    { text: text, mentions: mentions },
    { ephemeralExpiration: 86400 }, // 24 hours
  )
}

async function reactInGroup(
  groupId: string,
  messageKey: IMessageKey,
  socket: WASocket,
  text: string,
) {
  await socket.sendMessage(groupId, {
    react: {
      text: text,
      key: messageKey,
    },
  })
}
