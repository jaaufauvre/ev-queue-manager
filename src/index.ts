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

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------
;(async () => {
  Logger.setDebug(false)
  Logger.info(Color.Yellow, '🤖 Starting ...')

  // Auto-reset at 6am Dublin Time
  cron.schedule(
    '0 6 * * *',
    () => {
      Logger.info(Color.Yellow, '🕓 Scheduled queue reset')
      GROUP_QUEUES.clear()
      PROCESSED_MESSAGES.clear()
    },
    { timezone: 'Europe/Dublin' },
  )

  // Forever loop
  let attempt = 0
  while (true) {
    attempt++
    try {
      Logger.info(`Attempt ${attempt} at connecting to WA ...`)
      await start()
    } catch (err) {
      Logger.error('Unexpected interruption: ' + err)
    }
    Logger.info(`Waiting 5s before reconnecting ...`)
    await new Promise((res) => setTimeout(res, 5000))
  }
})()

// ---------------------------------------------------------------------------
// CONNECTION TO WA
// ---------------------------------------------------------------------------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

  // Fetch the exact version WA servers expect
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
    version: version,
    browser: Browsers.macOS('Chrome'),
    auth: state,
    printQRInTerminal: true,
  })

  // Save credentials so we persist the session
  socket.ev.on('creds.update', saveCreds)

  // Critical section
  return new Promise<void>((resolve, reject) => {
    let finished = false
    const finish = (err?: any): void => {
      if (finished) return
      finished = true
      socket.ev.removeAllListeners('creds.update')
      socket.ev.removeAllListeners('messages.upsert')
      socket.ev.removeAllListeners('connection.update')
      socket.ws?.removeAllListeners()
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }

    socket.ev.on('messages.upsert', async (m) => {
      try {
        await handleUserMessages(m, socket)
      } catch (err) {
        Logger.error('Error while handling messages')
        finish(err)
      }
    })

    socket.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        Logger.error('Connection closed: ', lastDisconnect?.error)
        finish()
      }
      if (connection === 'open') {
        Logger.info('✅  Connected!')
      }
    })

    // Low-level WebSocket guards
    socket.ws?.on('error', (err: unknown) => {
      Logger.error('WebSocket error:', err)
      finish(err)
    })
    socket.ws?.on('close', (code: number, reason: Buffer) => {
      Logger.error(`WebSocket closed: ${code} ${reason.toString()}`)
      finish()
    })
  })
}

// ---------------------------------------------------------------------------
// MESSAGE HANDLING
// ---------------------------------------------------------------------------
async function handleUserMessages(
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
    const msgKey = msg.key
    if (!msgKey) {
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
    const uniqueId = `${groupId}|${msgKey.id}`
    if (PROCESSED_MESSAGES.has(uniqueId)) {
      Logger.debug('Message ID already processed, ignoring')
      return
    }
    PROCESSED_MESSAGES.add(uniqueId)
    Logger.info(Color.Green, `Command: ${text}`)
    Logger.info(Color.Green, `Username: ${username}`)
    Logger.info(Color.Green, `User ID: ${userId}`)
    Logger.info(Color.Green, `Group ID: ${groupId}`)
    await handleCommand(groupId, msgKey, msg, socket, text, userId, username)
  }
}

// ---------------------------------------------------------------------------
// COMMAND HANDLING
// ---------------------------------------------------------------------------
async function handleCommand(
  groupId: string,
  msgKey: IMessageKey,
  msg: WAMessage,
  socket: WASocket,
  command: string,
  userId: string,
  username: string,
) {
  switch (command.toLowerCase().trim()) {
    case '/help':
    case '/h':
      await replyInGroup(
        groupId,
        msg,
        socket,
        `Available commands:
* \`/help\` (\`/h\`) – View the command menu
* \`/join\` (\`/j\`) – Enter the queue
* \`/leave\` (\`/l\`) – Exit the queue
* \`/queue\` (\`/q\`) – Display the queue`,
      )
      await reactInGroup(groupId, msgKey, socket, '🆘')
      break

    case '/join':
    case '/j':
      if (!isUserInQueue(groupId, userId)) {
        addUserToQueue(groupId, userId, username)
        await replyInGroup(
          groupId,
          msg,
          socket,
          `${username} joined the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, socket, '👍')
      } else {
        await replyInGroup(
          groupId,
          msg,
          socket,
          `${username}, you're already in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, socket, '❌')
      }
      break

    case '/leave':
    case '/l':
      if (!isUserInQueue(groupId, userId)) {
        await replyInGroup(
          groupId,
          msg,
          socket,
          `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, socket, '❌')
      } else {
        removeUserFromQueue(groupId, userId)
        await replyInGroup(
          groupId,
          msg,
          socket,
          `${username} left the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, socket, '👋')
      }
      break

    case '/queue':
    case '/q':
      await replyInGroup(
        groupId,
        msg,
        socket,
        `Queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, socket, '👀')
      break

    default:
      await replyInGroup(
        groupId,
        msg,
        socket,
        `Unknown command. Send \`/help\` for the list of commands.`,
      )
      await reactInGroup(groupId, msgKey, socket, '❌')
  }
}

// ---------------------------------------------------------------------------
// QUEUE HELPERS
// ---------------------------------------------------------------------------
interface Customer {
  userId: string
  username: string
}
const GROUP_QUEUES = new Map<string, Customer[]>()
function getGroupQueue(groupId: string): Customer[] {
  GROUP_QUEUES.set(groupId, GROUP_QUEUES.get(groupId) ?? [])
  return GROUP_QUEUES.get(groupId)!
}

function setGroupQueue(groupId: string, queue: Customer[]) {
  GROUP_QUEUES.set(groupId, queue)
}

function isUserInQueue(groupId: string, userId: string) {
  return getGroupQueue(groupId).find((customer) => customer.userId === userId)
}

function addUserToQueue(groupId: string, userId: string, username: string) {
  getGroupQueue(groupId).push({
    userId: userId,
    username: username,
  })
}

function removeUserFromQueue(groupId: string, userId: string) {
  const queue = getGroupQueue(groupId)
  setGroupQueue(
    groupId,
    queue.filter((customer) => customer.userId !== userId),
  )
}

function logQueue(groupId: string) {
  Logger.info(Color.Yellow, 'Queue: ' + JSON.stringify(getGroupQueue(groupId)))
}

// ---------------------------------------------------------------------------
// WA MESSAGE HELPERS
// ---------------------------------------------------------------------------
const PROCESSED_MESSAGES = new Set()

function userIdToMention(userId: string): string {
  const numberPart = userId.split('@')[0]
  return `@${numberPart}`
}

function formatQueueWithMentions(groupId: string) {
  logQueue(groupId)
  return (
    getGroupQueue(groupId)
      .map((customer, i) => `${i + 1}. ${userIdToMention(customer.userId)}`)
      .join('\n') || '—'
  )
}

function getQueueMentions(groupId: string): string[] {
  return getGroupQueue(groupId).map((customer) => customer.userId)
}

async function replyInGroup(
  groupId: string,
  msg: WAMessage,
  socket: WASocket,
  text: string,
  mentions: string[] = [],
) {
  await socket.sendMessage(
    groupId,
    { text: text, mentions: mentions },
    {
      quoted: msg, // Message we are replying to
      ephemeralExpiration: 86400, // 24 hours
    },
  )
}

async function reactInGroup(
  groupId: string,
  msgKey: IMessageKey,
  socket: WASocket,
  text: string,
) {
  await socket.sendMessage(groupId, {
    react: {
      text: text,
      key: msgKey,
    },
  })
}

// ---------------------------------------------------------------------------
// GLOBAL SAFETY NET
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  Logger.error('Unhandled rejection: ', reason)
})
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught exception:   ', error)
})
