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
          // Auto-detect: if text is valid card JSON, pass through (auto-convert v1→v2)
          if (text.trimStart().startsWith('{')) {
            try {
              const parsed = JSON.parse(text)
              // v2.0 card: schema + body.elements — pass through as-is
              if (parsed.schema === '2.0' && Array.isArray(parsed.body?.elements)) {
                isCardJson = true
              // v1 card: config + header + top-level elements — auto-convert to v2
              } else if (parsed.config && parsed.header && Array.isArray(parsed.elements)) {
                isCardJson = true
                const v2 = {
                  schema: '2.0',
                  config: parsed.config,
                  header: parsed.header,
                  body: { elements: parsed.elements },
                }
                text = JSON.stringify(v2)
                log.info(TAG, 'Auto-converted v1 card to v2 format')
              }
            } catch {}
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
            data: { msg_type: type, content: body },
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
          log.warn(TAG, `Card JSON rejected by Lark API, falling back to extracted text: ${sendErr}`)
          log.info(TAG, `Original card JSON (truncated): ${text.slice(0, 300)}`)
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
          data: { msg_type: 'image', content },
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
