import * as Lark from '@larksuiteoapi/node-sdk'
import { readFileSync } from 'fs'
import { Readable } from 'stream'
import type { LarkConfig, SendOpts } from '../../types.js'
import { log } from '../../utils/logger.js'

const TAG = 'lark-api'

function larkDomain(domain: string): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark
  if (domain === 'feishu') return Lark.Domain.Feishu
  return domain.replace(/\/+$/, '')
}

export class LarkApi {
  private _client: Lark.Client

  constructor(private config: LarkConfig) {
    this._client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: larkDomain(config.domain),
    })
  }

  get client(): Lark.Client { return this._client }

  async getBotOpenId(): Promise<string | undefined> {
    try {
      const res = await (this._client as any).request({
        method: 'GET', url: '/open-apis/bot/v3/info', data: {},
      })
      const bot = res?.bot ?? res?.data?.bot
      return bot?.open_id
    } catch (e) {
      log.warn(TAG, `Failed to fetch bot info: ${e}`)
      return undefined
    }
  }

  async sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<void> {
    try {
      const msgType = opts?.msgType ?? 'interactive'
      let finalMsgType: string = msgType
      let content: string
      let isCardJson = false

      switch (msgType) {
        case 'text':
          content = JSON.stringify({ text })
          break

        case 'post':
          // text should be post JSON: {"zh_cn":{"title":"...","content":[...]}}
          // If it's already JSON, pass through; otherwise wrap as simple post
          if (text.trimStart().startsWith('{')) {
            content = text
          } else {
            content = JSON.stringify({
              zh_cn: { title: '', content: [[{ tag: 'text', text }]] }
            })
          }
          break

        case 'image':
          // text should be image_key
          content = JSON.stringify({ image_key: text })
          break

        case 'file':
          // text should be file_key
          content = JSON.stringify({ file_key: text })
          break

        case 'audio':
          content = JSON.stringify({ file_key: text })
          break

        case 'media':
          // text should be JSON with file_key and image_key
          content = text.trimStart().startsWith('{') ? text : JSON.stringify({ file_key: text })
          break

        case 'sticker':
          content = JSON.stringify({ file_key: text })
          break

        case 'share_chat':
          content = JSON.stringify({ chat_id: text })
          break

        case 'share_user':
          content = JSON.stringify({ user_id: text })
          break

        case 'interactive':
        default:
          finalMsgType = 'interactive'
          // Auto-detect: if text is valid card JSON, pass through (auto-convert v1→v2, sanitize unsupported elements)
          if (text.trimStart().startsWith('{')) {
            try {
              const parsed = JSON.parse(text)
              // v2.0 card: schema + body.elements — sanitize then pass through
              if (parsed.schema === '2.0' && Array.isArray(parsed.body?.elements)) {
                isCardJson = true
                const { elements: sanitized, fixes } = sanitizeV2Elements(parsed.body.elements)
                parsed.body.elements = sanitized
                if (fixes.length) {
                  log.info(TAG, `Sanitized card: ${fixes.join('; ')}`)
                }
                text = JSON.stringify(parsed)
              // v1 card: config + header + top-level elements — auto-convert to v2
              } else if (parsed.config && parsed.header && Array.isArray(parsed.elements)) {
                isCardJson = true
                const { elements: sanitized, fixes } = sanitizeV2Elements(parsed.elements)
                const v2 = {
                  schema: '2.0',
                  config: parsed.config,
                  header: parsed.header,
                  body: { elements: sanitized },
                }
                text = JSON.stringify(v2)
                const allFixes = ['v1→v2 conversion', ...fixes]
                log.info(TAG, `Sanitized card: ${allFixes.join('; ')}`)
              }
            } catch (parseErr) {
              log.warn(TAG, `Card auto-detect: JSON.parse failed: ${parseErr} — text starts with: ${text.slice(0, 200)}`)
            }
          }
          if (!isCardJson && text.trimStart().startsWith('{')) {
            log.warn(TAG, `Card auto-detect MISS: text looks like JSON but didn't match v2 card format. First 500 chars: ${text.slice(0, 500)}`)
          }
          content = isCardJson ? text : JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true },
            body: { elements: [{ tag: 'markdown', content: text }] },
          })
          break
      }

      // Send with validation fallback: if card JSON fails, retry as markdown card
      const sendOnce = async (type: string, body: string) => {
        if (opts?.replyToMessageId) {
          await (this._client as any).im.message.reply({
            path: { message_id: opts.replyToMessageId },
            data: { msg_type: type, content: body, ...(opts?.threadId ? { reply_in_thread: true } : {}) },
          })
        } else {
          await (this._client as any).im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: type, content: body },
          })
        }
      }

      try {
        await sendOnce(finalMsgType, content)
      } catch (sendErr: any) {
        // If interactive card JSON failed, extract meaningful text and fallback
        if (finalMsgType === 'interactive' && isCardJson) {
          const errBody = sendErr?.response?.data ? JSON.stringify(sendErr.response.data) : 'no response body'
          log.warn(TAG, `Card JSON rejected by Lark API (${errBody}), falling back to extracted text`)
          log.info(TAG, `Original card JSON (first 1000 chars): ${text.slice(0, 1000)}`)
          const extracted = extractCardText(text)
          const fallback = JSON.stringify({
            schema: '2.0',
            config: { wide_screen_mode: true },
            body: { elements: [{ tag: 'markdown', content: extracted || '[卡片内容解析失败]' }] },
          })
          await sendOnce('interactive', fallback)
        } else {
          throw sendErr
        }
      }

      log.info(TAG, `Sent message to ${chatId}${opts?.replyToMessageId ? ` (reply to ${opts.replyToMessageId})` : ''}`)
    } catch (e) {
      log.error(TAG, `Failed to send message to ${chatId}: ${e}`)
      throw e
    }
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null> {
    const emojiType = resolveEmojiType(emoji)
    try {
      const res = await (this._client as any).im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      const reactionId = res?.reaction_id ?? res?.data?.reaction_id ?? null
      log.info(TAG, `addReaction ${emojiType} → reactionId=${reactionId} (keys: ${Object.keys(res?.data ?? res ?? {}).join(',')})`)
      return reactionId
    } catch (e) {
      log.warn(TAG, `Failed to add reaction ${emojiType} to ${messageId}: ${e}`)
      return null
    }
  }

  async removeReaction(chatId: string, messageId: string, reactionId: string): Promise<void> {
    try {
      await (this._client as any).im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    } catch (e) {
      log.warn(TAG, `Failed to remove reaction ${reactionId}: ${e}`)
    }
  }

  async fetchMessages(chatId: string, limit: number): Promise<Array<{ id: string; text: string; user: string }>> {
    try {
      const res = await (this._client as any).im.message.list({
        params: { container_id_type: 'chat', container_id: chatId, page_size: limit },
      })
      const items = res?.data?.items ?? []
      return items.map((item: any) => ({
        id: item.message_id,
        text: item.body?.content ?? '',
        user: item.sender?.id ?? '',
      }))
    } catch (e) {
      log.error(TAG, `Failed to fetch messages from ${chatId}: ${e}`)
      return []
    }
  }

  /** v6: Fetch chat messages for DM history injection. */
  async fetchChatMessages(chatId: string, limit: number = 20): Promise<Array<{
    messageId: string
    senderId: string
    senderName: string
    text: string
    createTime: number
    msgType: string
  }>> {
    try {
      const res = await (this._client as any).im.message.list({
        params: { container_id_type: 'chat', container_id: chatId, page_size: limit, sort_type: 'ByCreateTimeDesc' },
      })
      const items = res?.data?.items ?? []
      return items.map((item: any) => {
        const msgType = item.msg_type ?? 'text'
        let text = ''
        try {
          const content = item.body?.content ?? '{}'
          if (msgType === 'text') {
            const parsed = JSON.parse(content)
            text = parsed.text ?? ''
          } else if (msgType === 'post') {
            text = this._extractPostText(content)
          } else if (msgType === 'interactive') {
            text = extractCardText(content)
          } else {
            text = `[${msgType}]`
          }
        } catch {
          text = '[消息解析失败]'
        }

        return {
          messageId: item.message_id ?? '',
          senderId: item.sender?.id ?? '',
          senderName: item.sender?.id ?? '',
          text,
          createTime: Number(item.create_time ?? 0),
          msgType,
        }
      })
    } catch (e) {
      log.error(TAG, `Failed to fetch chat messages for ${chatId}: ${e}`)
      return []
    }
  }

  /** v5: Fetch thread messages for history injection. */
  async fetchThreadMessages(threadId: string, limit: number = 50): Promise<Array<{
    messageId: string
    senderId: string
    senderName: string
    text: string
    createTime: number
    msgType: string
  }>> {
    try {
      const res = await (this._client as any).im.message.list({
        params: { container_id_type: 'thread', container_id: threadId, page_size: limit },
      })
      const items = res?.data?.items ?? []
      return items.map((item: any) => {
        const msgType = item.msg_type ?? 'text'
        let text = ''
        try {
          const content = item.body?.content ?? '{}'
          if (msgType === 'text') {
            const parsed = JSON.parse(content)
            text = parsed.text ?? ''
          } else if (msgType === 'post') {
            text = this._extractPostText(content)
          } else if (msgType === 'interactive') {
            text = extractCardText(content)
          } else {
            text = `[${msgType}]`
          }
        } catch {
          text = '[消息解析失败]'
        }

        return {
          messageId: item.message_id ?? '',
          senderId: item.sender?.id ?? '',
          senderName: item.sender?.id ?? '',
          text,
          createTime: Number(item.create_time ?? 0),
          msgType,
        }
      })
    } catch (e) {
      log.error(TAG, `Failed to fetch thread messages for ${threadId}: ${e}`)
      return []
    }
  }

  /** Extract text from post (rich text) message content. */
  private _extractPostText(content: string): string {
    try {
      const parsed = JSON.parse(content)
      const parts: string[] = []
      if (parsed.title) parts.push(parsed.title)
      for (const para of parsed.content ?? []) {
        for (const el of para) {
          if (el.tag === 'text') parts.push(el.text ?? '')
          else if (el.tag === 'a') parts.push(el.text ?? el.href ?? '')
          else if (el.tag === 'at') parts.push(`@${el.user_name ?? el.user_id ?? ''}`)
        }
      }
      return parts.join(' ').trim() || '[富文本消息]'
    } catch {
      return '[富文本消息]'
    }
  }

  // ── Image methods ──

  /** Download an image resource from a message */
  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    try {
      const res = await (this._client as any).im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      })
      return await toBuffer(res)
    } catch (e) {
      log.error(TAG, `Failed to download image ${imageKey} from ${messageId}: ${e}`)
      throw e
    }
  }

  /** Upload an image file and return the image_key */
  async uploadImage(imagePath: string): Promise<string> {
    try {
      const buf = readFileSync(imagePath)
      const res = await (this._client as any).im.image.create({
        data: { image_type: 'message', image: buf },
      })
      const key = res?.image_key ?? res?.data?.image_key
      if (!key) throw new Error('image upload returned no image_key')
      log.info(TAG, `Uploaded image: ${imagePath} → ${key}`)
      return key
    } catch (e) {
      log.error(TAG, `Failed to upload image ${imagePath}: ${e}`)
      throw e
    }
  }

  /** Send an image message to a chat */
  async sendImage(chatId: string, imageKey: string, opts?: SendOpts): Promise<void> {
    try {
      const content = JSON.stringify({ image_key: imageKey })

      if (opts?.replyToMessageId) {
        await (this._client as any).im.message.reply({
          path: { message_id: opts.replyToMessageId },
          data: { msg_type: 'image', content, ...(opts?.threadId ? { reply_in_thread: true } : {}) },
        })
      } else {
        await (this._client as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'image', content },
        })
      }

      log.info(TAG, `Sent image ${imageKey} to ${chatId}`)
    } catch (e) {
      log.error(TAG, `Failed to send image to ${chatId}: ${e}`)
      throw e
    }
  }

  // ── Structured card object (from tool_use `card` param) ──

  /**
   * Send a card from a structured object. The caller (daemon.ts) passes
   * the card object directly from Claude's tool_use input — serialization
   * happens here via JSON.stringify, so string values are guaranteed to be
   * properly escaped. This bypasses the text-based auto-detect path entirely.
   *
   * Sanitization (v1→v2 conversion, note/action removal) still runs.
   */
  async sendCardObject(
    chatId: string,
    card: Record<string, unknown>,
    opts?: { replyToMessageId?: string; threadId?: string },
  ): Promise<void> {
    try {
      // Ensure v2 structure
      if (!card.schema) card.schema = '2.0'

      // Sanitize elements
      const elements = (card as any).body?.elements
      if (Array.isArray(elements)) {
        const { elements: sanitized, fixes } = sanitizeV2Elements(elements)
        ;(card as any).body.elements = sanitized
        if (fixes.length) {
          log.info(TAG, `sendCardObject sanitized: ${fixes.join('; ')}`)
        }
      }

      const content = JSON.stringify(card)

      const sendOnce = async (type: string, body: string) => {
        if (opts?.replyToMessageId) {
          await (this._client as any).im.message.reply({
            path: { message_id: opts.replyToMessageId },
            data: { msg_type: type, content: body, ...(opts?.threadId ? { reply_in_thread: true } : {}) },
          })
        } else {
          await (this._client as any).im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: type, content: body },
          })
        }
      }

      try {
        await sendOnce('interactive', content)
      } catch (sendErr: any) {
        // Card rejected by Lark API — fallback to extracted text as markdown card
        const errBody = sendErr?.response?.data ? JSON.stringify(sendErr.response.data) : 'no response body'
        log.warn(TAG, `sendCardObject rejected by Lark API (${errBody}), falling back to extracted text`)
        const extracted = extractCardText(content)
        const fallback = JSON.stringify({
          schema: '2.0',
          config: { wide_screen_mode: true },
          body: { elements: [{ tag: 'markdown', content: extracted || '[卡片内容解析失败]' }] },
        })
        await sendOnce('interactive', fallback)
      }

      log.info(TAG, `sendCardObject to ${chatId}${opts?.replyToMessageId ? ` (reply to ${opts.replyToMessageId})` : ''}`)
    } catch (e) {
      log.error(TAG, `sendCardObject failed for ${chatId}: ${e}`)
      throw e
    }
  }

  // ── Permission card ──

  /**
   * Send a permission prompt card with Allow/Deny buttons.
   * Returns the message_id of the sent card.
   */
  async sendPermissionCard(
    chatId: string,
    card: Record<string, unknown>,
    opts?: { replyToMessageId?: string },
  ): Promise<string> {
    try {
      const content = JSON.stringify(card)
      let res: any

      if (opts?.replyToMessageId) {
        res = await (this._client as any).im.message.reply({
          path: { message_id: opts.replyToMessageId },
          data: { msg_type: 'interactive', content },
        })
      } else {
        res = await (this._client as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        })
      }

      const messageId = res?.data?.message_id ?? 'unknown'
      log.info(TAG, `Permission card sent to ${chatId}: ${messageId}`)
      return messageId
    } catch (e) {
      log.error(TAG, `Failed to send permission card to ${chatId}: ${e}`)
      throw e
    }
  }

}

// ── Emoji type resolution ──

/**
 * Map common unicode emoji / aliases to valid Feishu emoji_type strings.
 * Casing aligned with larksuite/openclaw-lark FeishuEmoji + VALID_FEISHU_EMOJI_TYPES.
 * @see https://github.com/larksuite/openclaw-lark/blob/main/src/messaging/outbound/reactions.ts
 */
const EMOJI_MAP: Record<string, string> = {
  // Unicode → Feishu type (casing from VALID_FEISHU_EMOJI_TYPES)
  '👀': 'GLANCE', '👍': 'THUMBSUP', '👎': 'ThumbsDown', '✅': 'DONE',
  '❌': 'CrossMark', '🎉': 'PARTY', '❤️': 'HEART', '💔': 'HEARTBROKEN',
  '🤔': 'THINKING', '😂': 'LOL', '😢': 'CRY', '😱': 'TERROR',
  '🤦': 'FACEPALM', '💪': 'MUSCLE', '🔥': 'Fire', '💯': 'Hundred',
  '👏': 'APPLAUSE', '🙏': 'THANKS', '😊': 'SMILE', '😄': 'LAUGH',
  '🤗': 'HUG', '💀': 'SKULL', '💩': 'POOP', '🌹': 'ROSE',
  '🍺': 'BEER', '🎂': 'CAKE', '🎁': 'GIFT', '☕': 'Coffee',
  '🏆': 'Trophy', '💣': 'BOMB', '🎵': 'Music', '📌': 'Pin',
  '⏰': 'Alarm', '📢': 'Loudspeaker', '✔️': 'CheckMark',
}

/** Lowercase alias → Feishu type (for Claude tool calls that use lowercase names). */
const ALIAS_MAP: Record<string, string> = {
  'eyes': 'GLANCE', 'thumbsup': 'THUMBSUP', 'thumbsdown': 'ThumbsDown',
  'done': 'DONE', 'ok': 'OK', 'facepalm': 'FACEPALM', 'heart': 'HEART',
  'fire': 'Fire', 'thinking': 'THINKING', 'party': 'PARTY', 'typing': 'Typing',
  'onit': 'OnIt', 'lgtm': 'LGTM', 'muscle': 'MUSCLE', 'applause': 'APPLAUSE',
  'clap': 'CLAP', 'praise': 'PRAISE', 'skull': 'SKULL', 'poop': 'POOP',
  'checkmark': 'CheckMark', 'crossmark': 'CrossMark', 'hundred': 'Hundred',
}

/** Resolve emoji input to a valid Feishu emoji_type string. */
function resolveEmojiType(input: string): string {
  // Unicode emoji lookup
  if (EMOJI_MAP[input]) return EMOJI_MAP[input]
  // Already a valid Feishu type with correct casing (e.g. "DONE", "OnIt", "Typing")
  if (/^[A-Za-z0-9_]+$/.test(input)) {
    return ALIAS_MAP[input.toLowerCase()] ?? input
  }
  return input
}

// ── Card v2 sanitization ──

/** Recursively fix elements that are unsupported in card JSON v2. */
function sanitizeV2Elements(elements: any[]): { elements: any[]; fixes: string[] } {
  const fixes: string[] = []
  const result: any[] = []

  for (const el of elements) {
    // "note" is v1-only — convert to markdown
    if (el.tag === 'note') {
      const texts: string[] = []
      for (const child of el.elements ?? []) {
        if (child.content) texts.push(child.content)
        if (child.text) texts.push(child.text)
      }
      if (texts.length) {
        result.push({ tag: 'markdown', content: texts.join(' ') })
      }
      fixes.push('note→markdown')
      continue
    }

    // "action" wrapper is v1-only — unwrap buttons to top level
    if (el.tag === 'action' && Array.isArray(el.actions)) {
      for (const action of el.actions) {
        result.push(action)
      }
      fixes.push('action→unwrapped buttons')
      continue
    }

    // "collapsible_panel" — flatten into inline elements (no folding)
    if (el.tag === 'collapsible_panel') {
      // Add panel title as bold markdown
      const title = el.header?.title?.content
      if (title) {
        result.push({ tag: 'markdown', content: `**${title}**` })
      }
      // Flatten panel's inner elements to top level
      if (Array.isArray(el.elements)) {
        const nested = sanitizeV2Elements(el.elements)
        result.push(...nested.elements)
        fixes.push(...nested.fixes)
      }
      fixes.push('collapsible_panel→flattened')
      continue
    }

    // Recursively sanitize nested elements (column_set, form, interactive_container, etc.)
    if (Array.isArray(el.elements)) {
      const nested = sanitizeV2Elements(el.elements)
      el.elements = nested.elements
      fixes.push(...nested.fixes)
    }
    if (Array.isArray(el.columns)) {
      for (const col of el.columns) {
        if (Array.isArray(col.elements)) {
          const nested = sanitizeV2Elements(col.elements)
          col.elements = nested.elements
          fixes.push(...nested.fixes)
        }
      }
    }

    result.push(el)
  }

  return { elements: result, fixes }
}

// ── Card text extraction helper ──

/** Extract meaningful text from card JSON for fallback display. */
function extractCardText(jsonStr: string): string {
  try {
    const card = JSON.parse(jsonStr)
    const parts: string[] = []

    // Header title
    const title = card.header?.title?.content ?? card.header?.title?.text
    if (title) parts.push(`**${title}**`)

    // Body elements (v2.0)
    const elements = card.body?.elements ?? card.elements ?? []
    collectElementText(elements, parts)

    return parts.join('\n\n')
  } catch {
    return ''
  }
}

function collectElementText(elements: unknown[], parts: string[]): void {
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue
    const e = el as Record<string, unknown>

    switch (e.tag) {
      case 'markdown':
        if (e.content) parts.push(String(e.content))
        break
      case 'div':
        if (e.text && typeof e.text === 'object') {
          const t = e.text as Record<string, unknown>
          if (t.content) parts.push(String(t.content))
        }
        break
      case 'plain_text':
        if (e.content) parts.push(String(e.content))
        break
      case 'column_set':
        if (Array.isArray(e.columns)) {
          for (const col of e.columns) {
            if (col && typeof col === 'object' && Array.isArray((col as any).elements)) {
              collectElementText((col as any).elements, parts)
            }
          }
        }
        break
      case 'collapsible_panel':
        if (Array.isArray(e.elements)) {
          collectElementText(e.elements as unknown[], parts)
        }
        break
    }
  }
}

// ── Buffer conversion helper ──

async function toBuffer(response: unknown): Promise<Buffer> {
  const r = response as any
  if (Buffer.isBuffer(response)) return response
  if (response instanceof ArrayBuffer) return Buffer.from(response)
  if (Buffer.isBuffer(r?.data)) return r.data
  if (r?.data instanceof ArrayBuffer) return Buffer.from(r.data)
  if (typeof r?.getReadableStream === 'function') {
    const chunks: Buffer[] = []
    for await (const chunk of r.getReadableStream()) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
    }
    return Buffer.concat(chunks)
  }
  if (response instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of response) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer))
    }
    return Buffer.concat(chunks)
  }
  throw new Error('Unsupported response format for media download')
}
