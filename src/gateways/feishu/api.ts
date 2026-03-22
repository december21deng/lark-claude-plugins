import * as Lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig, SendOpts } from '../../types.js'
import { log } from '../../utils/logger.js'

const TAG = 'feishu-api'

function larkDomain(domain: string): Lark.Domain | string {
  if (domain === 'lark') return Lark.Domain.Lark
  if (domain === 'feishu') return Lark.Domain.Feishu
  return domain.replace(/\/+$/, '')
}

export class FeishuApi {
  private _client: Lark.Client

  constructor(private config: FeishuConfig) {
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
      // Build interactive card (same as plugin's sendReply)
      const card = {
        schema: '2.0',
        config: { wide_screen_mode: true },
        body: { elements: [{ tag: 'markdown', content: text }] },
      }
      const content = JSON.stringify(card)

      if (opts?.replyToMessageId) {
        // Reply to specific message (stays in thread)
        await (this._client as any).im.message.reply({
          path: { message_id: opts.replyToMessageId },
          data: { msg_type: 'interactive', content },
        })
      } else {
        // New message to chat
        await (this._client as any).im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
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
}
