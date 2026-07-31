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
if (require.main === module) {
  void (async () => {
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
            'The queue was cleared. Send `/j` to join the queue, `/h` for the list of commands.',
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
}

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
    const command = text.trim()
    Logger.info(Color.Green, `Command: ${command}`)
    Logger.info(Color.Green, `Username: ${username}`)
    Logger.info(Color.Green, `User IDs: ${[...userIds].join(', ')}`)
    Logger.info(Color.Green, `Group ID: ${groupId}`)
    PROCESSED_MESSAGES.add(uniqueId)
    await handleCommand(groupId, msgKey, msg, command, userIds, username!)
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
  const normalizedCommand = command.toLowerCase()

  if (normalizedCommand.length > 80) {
    await replyInGroup(
      groupId,
      msg,
      'Command length exceeded. Send `/h` for the list of commands.',
    )
    await reactInGroup(groupId, msgKey, '❌')
    return
  }

  if (normalizedCommand === '/help' || normalizedCommand === '/h') {
    await reactInGroup(groupId, msgKey, '🆘')
    await replyInGroup(
      groupId,
      msg,
      `Available commands:
* Queue: \`/j\`(join) \`/j note\`(join with note) \`/l\`(leave) \`/c\`(check)
* Your status: \`/b\`(busy) \`/a\`(available)
* Notes: \`/n note\`(add, update) \`/n\`(clear)
* Help menu: \`/h\`(help)`,
    )
    return
  }

  if (normalizedCommand === '/leave' || normalizedCommand === '/l') {
    if (!isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    removeUserFromQueue(groupId, userIds)
    await replyInGroup(
      groupId,
      msg,
      `${username}, you left the queue:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '👋')
    await writeQueueFile()
    return
  }

  if (normalizedCommand === '/busy' || normalizedCommand === '/b') {
    if (!isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    if (!isUserAvailable(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're already busy:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    makeUserAvailable(groupId, userIds, false)
    await replyInGroup(
      groupId,
      msg,
      `${username}, you're now busy:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '⏳')
    await writeQueueFile()
    return
  }

  if (normalizedCommand === '/available' || normalizedCommand === '/a') {
    if (!isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    if (isUserAvailable(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're already available:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    makeUserAvailable(groupId, userIds, true)
    await replyInGroup(
      groupId,
      msg,
      `${username}, you're available again:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '👍')
    await writeQueueFile()
    return
  }

  if (normalizedCommand === '/check' || normalizedCommand === '/c') {
    await replyInGroup(
      groupId,
      msg,
      `Queue:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '👀')
    return
  }

  if (
    normalizedCommand === '/join' ||
    normalizedCommand === '/j' ||
    normalizedCommand.startsWith('/join ') ||
    normalizedCommand.startsWith('/j ')
  ) {
    if (isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're already in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    if (!hasValidNote(command)) {
      await replyInGroup(
        groupId,
        msg,
        'Invalid note. Send `/h` for the list of commands.',
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    addUserToQueue(groupId, userIds, username, extractNote(command))
    await replyInGroup(
      groupId,
      msg,
      `${username}, you joined the queue:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '👍')
    await writeQueueFile()
    return
  }

  if (normalizedCommand === '/note' || normalizedCommand === '/n') {
    if (!isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    if (!isUserWithNote(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you don't have a note:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    updateUserNote(groupId, userIds, undefined)
    await replyInGroup(
      groupId,
      msg,
      `${username}, your note was cleared:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '👍')
    await writeQueueFile()
    return
  }

  if (
    normalizedCommand.startsWith('/note ') ||
    normalizedCommand.startsWith('/n ')
  ) {
    if (!isUserInQueue(groupId, userIds)) {
      await replyInGroup(
        groupId,
        msg,
        `${username}, you're not in the queue:\n${formatQueueWithMentions(groupId)}`,
        getQueueMentions(groupId),
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    if (!hasValidNote(command)) {
      await replyInGroup(
        groupId,
        msg,
        'Invalid note. Send `/h` for the list of commands.',
      )
      await reactInGroup(groupId, msgKey, '❌')
      return
    }
    updateUserNote(groupId, userIds, extractNote(command))
    await replyInGroup(
      groupId,
      msg,
      `${username}, your note was updated:\n${formatQueueWithMentions(groupId)}`,
      getQueueMentions(groupId),
    )
    await reactInGroup(groupId, msgKey, '📝')
    await writeQueueFile()
    return
  }

  await replyInGroup(
    groupId,
    msg,
    'Unknown command. Send `/h` for the list of commands.',
  )
  await reactInGroup(groupId, msgKey, '❌')
}

// ---------------------------------------------------------------------------
// QUEUE HELPERS
// ---------------------------------------------------------------------------
interface Customer {
  userIds: Set<string>
  username: string
  available: boolean
  note?: string
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

function isUserAvailable(groupId: string, userIds: Set<string>): boolean {
  return getGroupQueue(groupId).some(
    (customer) => intersects(customer.userIds, userIds) && customer.available,
  )
}

function isUserWithNote(groupId: string, userIds: Set<string>): boolean {
  return getGroupQueue(groupId).some(
    (customer) => intersects(customer.userIds, userIds) && customer.note,
  )
}

function addUserToQueue(
  groupId: string,
  userIds: Set<string>,
  username: string,
  note?: string,
): void {
  getGroupQueue(groupId).push({
    userIds: userIds,
    username: username,
    available: true,
    note: note,
  })
}

function removeUserFromQueue(groupId: string, userIds: Set<string>): void {
  const queue = getGroupQueue(groupId)
  setGroupQueue(
    groupId,
    queue.filter((customer) => !intersects(customer.userIds, userIds)),
  )
}

function makeUserAvailable(
  groupId: string,
  userIds: Set<string>,
  available: boolean,
): void {
  const queue = getGroupQueue(groupId)
  const user = queue.find((customer) => intersects(customer.userIds, userIds))
  if (user) {
    user.available = available
  }
}

function updateUserNote(
  groupId: string,
  userIds: Set<string>,
  note?: string,
): void {
  const queue = getGroupQueue(groupId)
  const user = queue.find((customer) => intersects(customer.userIds, userIds))
  if (user) {
    user.note = note
  }
}

function logQueue(groupId: string): void {
  Logger.info(
    Color.Yellow,
    'Queue: ' +
      JSON.stringify(
        getGroupQueue(groupId).map((customer) => ({
          userIds: [...customer.userIds],
          username: customer.username,
          available: customer.available,
          note: customer.note,
        })),
      ),
  )
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
    const queues = [...GROUP_QUEUES].map(([groupId, customers]) => [
      groupId,
      customers.map(({ userIds, username, available, note }) => ({
        userIds: [...userIds],
        username,
        available,
        note,
      })),
    ])
    await fs.writeFile(
      getQueueFilepath(),
      JSON.stringify(queues, null, 2),
      'utf-8',
    )
  } catch (err) {
    Logger.warn(`Couldn't write queue file: ${err}`)
  }
}

async function readQueueFile(): Promise<void> {
  try {
    Logger.info(Color.LightBlue, 'Reading queue file')
    const queueJson = await fs.readFile(getQueueFilepath(), 'utf-8')
    const queues = JSON.parse(queueJson) as [
      string,
      {
        userIds: string[]
        username: string
        available: boolean
        note?: string
      }[],
    ][]
    GROUP_QUEUES.clear()
    for (const [groupId, customers] of queues) {
      setGroupQueue(
        groupId,
        customers.map((c) => ({
          userIds: new Set(c.userIds),
          username: c.username,
          available: c.available,
          note: c.note,
        })),
      )
    }
  } catch (err) {
    Logger.warn(`Couldn't read queue file: ${err}`)
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

// A valid note is 0–80 characters of letters, numbers, spaces, punctuation, or emoji—but no forward slashes or @ signs or formatting
export function hasValidNote(command: string): boolean {
  const note = command.replace(/\/(join|note|j|n)\s*/i, '').trim()
  return /^(?!.*[/@~_*`])[\p{L}\p{M}\p{N}\p{Zs}\p{P}\p{S}]{0,80}$/u.test(note)
}

export function extractNote(command: string): string | undefined {
  if (!hasValidNote(command)) {
    return undefined
  }
  const note = command.replace(/\/(join|note|j|n)\s*/i, '').trim()
  if (note.length === 0) {
    return undefined
  }
  if (note.length > 40) {
    return Array.from(note).slice(0, 40).join('') + '…' // 40 first "visible" chars only
  }
  return note
}

function userIdToMention(userId: string): string {
  const numberPart = userId.split('@')[0]
  return `@${numberPart}`
}

function customerToNote(customer: Customer): string {
  const available = customer.available
  const note = customer.note
  if (!available) {
    return " — skip me, I'm busy"
  }
  if (note) {
    return ` — ${note}`
  }
  return ''
}

function formatQueueWithMentions(groupId: string): string {
  logQueue(groupId)
  return (
    getGroupQueue(groupId)
      .map(
        (customer, i) =>
          `${i + 1}. ${userIdToMention(Array.from(customer.userIds)[0])}${customerToNote(customer)}`,
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
