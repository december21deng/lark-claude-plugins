// ── Attachment from incoming message ──

export interface Attachment {
  type: 'image' | 'file'
  imageKey?: string
  fileKey?: string
  fileName?: string
  localPath?: string
}

// ── Parsed message from any gateway ──

export interface ParsedMessage {
  platform: string        // 'lark' | 'discord'
  chatId: string
  messageId: string
  threadId?: string
  senderId: string
  senderName: string
  text: string
  chatType: 'private' | 'group'
  mentionedBot: boolean
  attachments?: Attachment[]
}

// ── Gateway interface ──

// All Lark-supported msg_type values
export type MsgType = 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'sticker' | 'interactive' | 'share_chat' | 'share_user'

export interface SendOpts {
  replyToMessageId?: string
  threadId?: string
  msgType?: MsgType  // default: 'interactive'
}

export interface Gateway {
  readonly platform: string
  start(onMessage: (msg: ParsedMessage) => void): Promise<void>
  stop(): Promise<void>
  sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<void>
  sendCard(chatId: string, card: Record<string, unknown>, opts?: SendOpts): Promise<void>
  sendImage(chatId: string, imageKey: string, opts?: SendOpts): Promise<void>
  downloadImage(messageId: string, imageKey: string): Promise<Buffer>
  uploadImage(imagePath: string): Promise<string>
  addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null>
  removeReaction(chatId: string, messageId: string, reactionId: string): Promise<void>
  fetchMessages(chatId: string, limit: number): Promise<Array<{ id: string; text: string; user: string }>>
}

// ── Worker pool types ──

export interface Worker {
  proc: any | null  // node-pty IPty instance
  port: number
  convKey: string | null
  startedAt: number
  ready: boolean
  pid: number | null
  busy: boolean            // v5: true when actively processing a message
  lastActivityAt: number   // v5: timestamp of last tool-call (heartbeat)
  idx: number              // v5: worker index in pool
}

// v4: Pending message for when pool is exhausted
export interface PendingMessage {
  convKey: string
  msg: ParsedMessage
  queuedAt: number
}

// ── Tool call proxy ──

export interface ToolCallRequest {
  tool: string
  args: Record<string, unknown>
  convKey: string
  platform: string
}

export interface ToolCallResponse {
  result: { content: Array<{ type: string; text: string }> }
  isError?: boolean
}

// ── Config ──

export interface LarkConfig {
  appId: string
  appSecret: string
  domain: 'feishu' | 'lark'
  superadmins?: string[]
  access: AccessConfig
}

export interface AccessConfig {
  dmPolicy: 'open' | 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, { requireMention: boolean; allowFrom?: string[] }>
  groupAutoReply: string[]
}

export interface PoolConfig {
  minWorkers: number        // v5: minimum always-alive workers (default: 10)
  maxWorkers: number        // v5: maximum workers (dynamic spawn up to this)
  basePort: number
  daemonApiPort: number
  clearDelayMs?: number     // v5: IDLE → /clear delay (default: 60_000 = 1 min)
  killDelayMs?: number      // v5: BARE → kill delay when > minWorkers (default: 300_000 = 5 min)
  busyTimeoutMs?: number    // v5: BUSY timeout, force idle if no heartbeat (default: 600_000 = 10 min)
}

export interface ClaudeConfig {
  bin: string
  pluginChannel: string
  systemPrompt?: string
  model?: string
}

export interface AppConfig {
  lark: LarkConfig
  pool: PoolConfig
  claude: ClaudeConfig
  log: { level: string; dir: string }
}
