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
      let finalMsgType: string
      let content: string

      if (msgType === 'text') {
        finalMsgType = 'text'
        content = JSON.stringify({ text })
      } else {
        finalMsgType = 'interactive'
        // Auto-detect: if text is already a valid card JSON, pass through directly
        // Otherwise wrap in a markdown card
        let isCardJson = false
        if (text.trimStart().startsWith('{')) {
          try {
            const parsed = JSON.parse(text)
            if (parsed.schema || parsed.config || parsed.header || parsed.elements) {
              isCardJson = true
            }
          } catch {}
        }

        if (isCardJson) {
          content = text
        } else {
          const card = {
            schema: '2.0',
            config: { wide_screen_mode: true },
            body: { elements: [{ tag: 'markdown', content: text }] },
          }
          content = JSON.stringify(card)
        }
      }

      if (opts?.replyToMessageId) {
        await (this._client as any).im.message.reply({
          path: { message_id: opts.replyToMessageId },
          data: { msg_type: finalMsgType, content },
        })
      } else {
        await (this._client as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: finalMsgType, content },
        })
      }

      log.info(TAG, `Sent message to ${chatId}${opts?.replyToMessageId ? ` (reply to ${opts.replyToMessageId})` : ''}`)
    } catch (e) {
      log.error(TAG, `Failed to send message to ${chatId}: ${e}`)
      throw e
    }
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null> {
    try {
      const res = await (this._client as any).im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res?.reaction_id ?? res?.data?.reaction_id ?? null
    } catch (e) {
      log.warn(TAG, `Failed to add reaction ${emoji} to ${messageId}: ${e}`)
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
