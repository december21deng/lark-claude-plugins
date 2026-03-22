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
          // Auto-detect: if text is valid card JSON, pass through
          let isCardJson = false
          if (text.trimStart().startsWith('{')) {
            try {
              const parsed = JSON.parse(text)
              if (parsed.schema || parsed.config || parsed.header || parsed.elements) {
                isCardJson = true
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

  // ── CardKit streaming API ──

  /**
   * Create a card entity via cardkit API. Returns the card_id.
   */
  async createCardEntity(card: Record<string, unknown>): Promise<string> {
    try {
      const res = await (this._client as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(card) },
      })
      if (res?.code !== 0) {
        throw new Error(`createCardEntity failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
      const cardId = res?.data?.card_id
      if (!cardId) throw new Error('Card entity created but no card_id returned')
      log.info(TAG, `Card entity created: ${cardId}`)
      return cardId
    } catch (e) {
      log.error(TAG, `Failed to create card entity: ${e}`)
      throw e
    }
  }

  /**
   * Send a card entity by card_id reference. Returns the message_id.
   */
  async sendCardByRef(
    chatId: string,
    cardId: string,
    opts?: { replyToMessageId?: string },
  ): Promise<string> {
    try {
      const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
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
      log.info(TAG, `Card ref ${cardId} sent to ${chatId}: ${messageId}`)
      return messageId
    } catch (e) {
      log.error(TAG, `Failed to send card ref to ${chatId}: ${e}`)
      throw e
    }
  }

  /**
   * Insert card elements (create elements within a card entity).
   */
  async insertCardElement(
    cardId: string,
    opts: {
      type: 'insert_before' | 'insert_after' | 'append'
      targetElementId?: string
      elements: Record<string, unknown>[]
      sequence: number
    },
  ): Promise<void> {
    try {
      const res = await (this._client as any).cardkit.v1.cardElement.create({
        path: { card_id: cardId },
        data: {
          type: opts.type,
          target_element_id: opts.targetElementId,
          elements: JSON.stringify(opts.elements),
          sequence: opts.sequence,
        },
      })
      if (res?.code !== 0) {
        throw new Error(`insertCardElement failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
    } catch (e) {
      log.error(TAG, `Failed to insert card element: ${e}`)
      throw e
    }
  }

  /**
   * Partially update a card element's properties.
   */
  async patchCardElement(
    cardId: string,
    elementId: string,
    partial: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await (this._client as any).cardkit.v1.cardElement.patch({
        path: { card_id: cardId, element_id: elementId },
        data: { partial_element: JSON.stringify(partial), sequence },
      })
      if (res?.code !== 0) {
        throw new Error(`patchCardElement failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
    } catch (e) {
      log.error(TAG, `Failed to patch card element: ${e}`)
      throw e
    }
  }

  /**
   * Stream-update a text/markdown element's content (typewriter effect).
   * Pass the FULL accumulated text — the platform computes the delta.
   */
  async updateCardElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await (this._client as any).cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence },
      })
      if (res?.code !== 0) {
        throw new Error(`updateCardElementContent failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
    } catch (e) {
      log.error(TAG, `Failed to update card element content: ${e}`)
      throw e
    }
  }

  /**
   * Delete a card element by ID.
   */
  async deleteCardElement(
    cardId: string,
    elementId: string,
    sequence: number,
  ): Promise<void> {
    try {
      const res = await (this._client as any).cardkit.v1.cardElement.delete({
        path: { card_id: cardId, element_id: elementId },
        data: { sequence },
      })
      if (res?.code !== 0) {
        throw new Error(`deleteCardElement failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
    } catch (e) {
      log.error(TAG, `Failed to delete card element: ${e}`)
      throw e
    }
  }

  /**
   * Close streaming mode for a card entity.
   */
  async closeCardStreaming(cardId: string, sequence: number): Promise<void> {
    try {
      const res = await (this._client as any).cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence,
        },
      })
      if (res?.code !== 0) {
        throw new Error(`closeCardStreaming failed (code ${res?.code}): ${res?.msg ?? ''}`)
      }
      log.info(TAG, `Streaming closed for card ${cardId}`)
    } catch (e) {
      log.error(TAG, `Failed to close card streaming: ${e}`)
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
