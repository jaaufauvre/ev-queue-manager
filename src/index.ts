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
type IMessageKey = proto.IMessageKey
import { promises as fs } from 'node:fs'
import path from 'node:path'
import qrcode from 'qrcode-terminal'

// ---------------------------------------------------------------------------
// GLOBAL SOCKET INSTANCE
// ---------------------------------------------------------------------------
let socket: WASocket

  // ---------------------------------------------------------------------------
  // ENTRY POINT
  // ---------------------------------------------------------------------------
;(async () => {
  Logger.setDebug(false)
  Logger.info(Color.Yellow, '🤖 Starting ...')
  await readQueueFile()

  // Auto-reset at 6am Dublin Time
  cron.schedule(
    '0 6 * * *',
    async () => {
      Logger.info(Color.Yellow, '🕓 Scheduled queue reset')
      await deleteQueueFile()
      GROUP_QUEUES.clear()
      PROCESSED_MESSAGES.clear()
      const groups = await socket.groupFetchAllParticipating()
      for (const groupId of Object.keys(groups)) {
        await postInGroup(
          groupId,
          'The queue was cleared. Send `/join` to join the queue, `/help` for the list of commands.',
        )
      }
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

  socket = makeWASocket({
    version: version,
    browser: Browsers.macOS('Chrome'),
    auth: state,
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
        await handleUserMessages(m)
      } catch (err) {
        Logger.error('Error while handling messages')
        finish(err)
      }
    })

    socket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrcode.generate(qr, { small: true })
        Logger.info(Color.Yellow, 'Scan the QR in WhatsApp → Linked devices')
      }
      if (connection === 'close') {
        Logger.error('Connection closed: ', lastDisconnect?.error)
        finish()
      }
      if (connection === 'open') {
        Logger.info('✅ Connected!')
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
async function handleUserMessages(m: {
  messages: WAMessage[]
  type: MessageUpsertType
  requestId?: string
}) {
  if (!m.messages || m.messages.length === 0) {
    Logger.debug('No messages, ignoring')
    return
  }
  for (const msg of m.messages) {
    if (!msg.message) {
      Logger.debug('No message, ignoring')
      continue
    }
    const msgKey = msg.key
    if (!msgKey) {
      Logger.debug('No key for message, ignoring')
      continue
    }
    const messageId = msgKey.id
    if (!messageId) {
      Logger.debug('No ID for message, ignoring')
      continue
    }
    const groupId = msgKey.remoteJid
    if (!groupId || !groupId.endsWith('@g.us')) {
      Logger.debug('Not from a group, ignoring')
      continue
    }
    Logger.debug('Message: ' + JSON.stringify(msg))
    if (msgKey.fromMe) {
      Logger.debug('Own message, ignoring')
      continue
    }
    const username = msg.pushName
    if (isEmpty(username)) {
      Logger.debug('No user name, ignoring')
      continue
    }
    const userIds = new Set<string>(
      [msgKey.participant, msgKey.participantAlt].filter(
        (id): id is string => !isEmpty(id),
      ),
    )
    if (userIds.size === 0) {
      Logger.debug('No user ID, ignoring')
      continue
    }

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.ephemeralMessage?.message?.conversation ||
      msg.message.ephemeralMessage?.message?.extendedTextMessage?.text
    if (!text?.startsWith('/')) {
      Logger.debug('Not a command, ignoring')
      continue
    }
    const uniqueId = `${groupId}|${messageId}`
    if (PROCESSED_MESSAGES.has(uniqueId)) {
      Logger.debug('Message ID already processed, ignoring')
      continue
    }
    Logger.info(Color.Green, `Command: ${text}`)
    Logger.info(Color.Green, `Username: ${username}`)
    Logger.info(Color.Green, `User IDs: ${userIds}`)
    Logger.info(Color.Green, `Group ID: ${groupId}`)
    PROCESSED_MESSAGES.add(uniqueId)
    await handleCommand(groupId, msgKey, msg, text, userIds, username!)
  }
}

// ---------------------------------------------------------------------------
// COMMAND HANDLING
// ---------------------------------------------------------------------------
async function handleCommand(
  groupId: string,
  msgKey: IMessageKey,
  msg: WAMessage,
  command: string,
  userIds: Set<string>,
  username: string,
) {
  switch (command.toLowerCase().trim()) {
    case '/help':
    case '/h':
      await replyInGroup(
        groupId,
        msg,
        `Available commands:
* \`/help\` (\`/h\`) → Display this menu
* \`/join\` (\`/j\`) → Join the queue
* \`/leave\` (\`/l\`) → Leave the queue
* \`/check\` (\`/c\`) → Check the queue`,
      )
      await reactInGroup(groupId, msgKey, '🆘')
      break

    case '/join':
    case '/j':
      if (!isUserInQueue(groupId, userIds)) {
        addUserToQueue(groupId, userIds, username)
        await replyInGroup(
          groupId,
          msg,
          `${username}, you joined the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, '👍')
        await writeQueueFile()
      } else {
        await replyInGroup(
          groupId,
          msg,
          `${username}, you're already in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, '❌')
      }
      break

    case '/leave':
    case '/l':
      if (!isUserInQueue(groupId, userIds)) {
        await replyInGroup(
          groupId,
          msg,
          `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, '❌')
      } else {
        removeUserFromQueue(groupId, userIds)
        await replyInGroup(
          groupId,
          msg,
          `${username}, you left the queue:\n${formatQueueWithMentions(groupId)}`,
          getQueueMentions(groupId),
        )
        await reactInGroup(groupId, msgKey, '👋')
        await writeQueueFile()
      }
      break

    case '/check':
    case '/c':
      await replyInGroup(
        groupId,
        msg,
        `Queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '👀')
      break

    default:
      await replyInGroup(
        groupId,
        msg,
        'Unknown command. Send `/help` for the list of commands.',
      )
      await reactInGroup(groupId, msgKey, '❌')
  }
}

// ---------------------------------------------------------------------------
// QUEUE HELPERS
// ---------------------------------------------------------------------------
interface Customer {
  userIds: Set<string>
  username: string
}
const GROUP_QUEUES = new Map<string, Customer[]>()
function getGroupQueue(groupId: string): Customer[] {
  GROUP_QUEUES.set(groupId, GROUP_QUEUES.get(groupId) ?? [])
  return GROUP_QUEUES.get(groupId)!
}

function setGroupQueue(groupId: string, queue: Customer[]): void {
  GROUP_QUEUES.set(groupId, queue)
}

function isUserInQueue(groupId: string, userIds: Set<string>): boolean {
  return getGroupQueue(groupId).some((customer) =>
    intersects(customer.userIds, userIds),
  )
}

function addUserToQueue(
  groupId: string,
  userIds: Set<string>,
  username: string,
): void {
  getGroupQueue(groupId).push({
    userIds: userIds,
    username: username,
  })
}

function removeUserFromQueue(groupId: string, userIds: Set<string>): void {
  const queue = getGroupQueue(groupId)
  setGroupQueue(
    groupId,
    queue.filter((customer) => !intersects(customer.userIds, userIds)),
  )
}

function logQueue(groupId: string): void {
  Logger.info(Color.Yellow, 'Queue: ' + JSON.stringify(getGroupQueue(groupId)))
}

// ---------------------------------------------------------------------------
// QUEUE FILE HELPERS
// ---------------------------------------------------------------------------
function getQueueFilepath(): string {
  return path.resolve(process.cwd(), 'queues.json')
}

async function writeQueueFile(): Promise<void> {
  try {
    Logger.info(Color.LightBlue, 'Writing queue file')
    await fs.writeFile(
      getQueueFilepath(),
      JSON.stringify(Array.from(GROUP_QUEUES.entries()), null, 2),
      'utf-8',
    )
  } catch (err) {
    Logger.warn("Couldn't write queue file: " + err)
  }
}

async function readQueueFile(): Promise<void> {
  try {
    Logger.info(Color.LightBlue, 'Reading queue file')
    const rawJson = await fs.readFile(getQueueFilepath(), 'utf-8')
    const tuples = JSON.parse(rawJson) as [string, Customer[]][]
    GROUP_QUEUES.clear()
    for (const [groupId, customers] of tuples) {
      setGroupQueue(groupId, customers)
    }
  } catch (err) {
    Logger.warn("Couldn't read queue file: " + err)
  }
}

async function deleteQueueFile(): Promise<void> {
  try {
    Logger.info(Color.LightBlue, 'Deleting queue file')
    await fs.unlink(getQueueFilepath())
  } catch (err) {
    Logger.warn("Couldn't delete queue file: " + err)
  }
}

// ---------------------------------------------------------------------------
// WA MESSAGE HELPERS
// ---------------------------------------------------------------------------
const PROCESSED_MESSAGES = new Set<string>()

function userIdToMention(userId: string): string {
  const numberPart = userId.split('@')[0]
  return `@${numberPart}`
}

function formatQueueWithMentions(groupId: string): string {
  logQueue(groupId)
  return (
    getGroupQueue(groupId)
      .map(
        (customer, i) =>
          `${i + 1}. ${userIdToMention(Array.from(customer.userIds)[0])}`,
      )
      .join('\n') || '—'
  )
}

function getQueueMentions(groupId: string): string[] {
  return getGroupQueue(groupId).map(
    (customer) => Array.from(customer.userIds)[0],
  )
}

async function replyInGroup(
  groupId: string,
  msg: WAMessage,
  text: string,
  mentions: string[] = [],
): Promise<void> {
  await socket.sendMessage(
    groupId,
    { text: text, mentions: mentions },
    {
      quoted: msg, // Message we are replying to
      ephemeralExpiration: 86400, // 24 hours
    },
  )
}

async function postInGroup(groupId: string, text: string): Promise<void> {
  await socket.sendMessage(
    groupId,
    { text: text },
    {
      ephemeralExpiration: 86400, // 24 hours
    },
  )
}

async function reactInGroup(
  groupId: string,
  msgKey: IMessageKey,
  text: string,
): Promise<void> {
  await socket.sendMessage(groupId, {
    react: {
      text: text,
      key: msgKey,
    },
  })
}

// ---------------------------------------------------------------------------
// UTILS
// ---------------------------------------------------------------------------
function isEmpty(value: string | null | undefined): boolean {
  return !value || value.trim().length === 0
}

export const intersects = (a: Set<string>, b: Set<string>): boolean =>
  [...a].some((v) => b.has(v))

// ---------------------------------------------------------------------------
// GLOBAL SAFETY NET
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  Logger.error('Unhandled rejection: ', reason)
})
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught exception: ', error)
})
