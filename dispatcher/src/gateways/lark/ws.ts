import * as Lark from '@larksuiteoapi/node-sdk'
import type { LarkConfig, Gateway, ParsedMessage, SendOpts } from '../../types.js'
import { parseEvent, gate } from './receiver.js'
import { LarkApi } from './api.js'
import { handleCardAction } from '../../permission.js'
import { log } from '../../utils/logger.js'

const TAG = 'lark-gw'

export class LarkGateway implements Gateway {
  readonly platform = 'lark'

  private _wsClient: Lark.WSClient | null = null
  private _api: LarkApi
  private _botOpenId?: string
  private _config: LarkConfig

  // Track ack reactions per message for cleanup
  private _ackReactions = new Map<string, string>() // messageId → reactionId

  constructor(config: LarkConfig) {
    this._config = config
    this._api = new LarkApi(config)
  }

  get api(): LarkApi { return this._api }

  async start(onMessage: (msg: ParsedMessage) => void): Promise<void> {
    // Fetch bot open_id
    this._botOpenId = await this._api.getBotOpenId()
    log.info(TAG, `Bot open_id: ${this._botOpenId ?? 'unknown'}`)

    // Setup event dispatcher
    const dispatcher = new Lark.EventDispatcher({
      verificationToken: '',
      encryptKey: '',
    })

    // Register a catch-all to see if ANY events arrive
    const origProcess = (dispatcher as any).processEvent?.bind(dispatcher)
    if (origProcess) {
      ;(dispatcher as any).processEvent = (event: any) => {
        log.info(TAG, `RAW EVENT: type=${event?.header?.event_type ?? 'unknown'}`)
        return origProcess(event)
      }
    }

    dispatcher.register({
      // v2: Card action callback for permission buttons
      'card.action.trigger_v1': async (data: any) => {
        log.info(TAG, `CARD ACTION: ${JSON.stringify(data?.action?.value ?? {}).slice(0, 200)}`)
        const handled = handleCardAction(data)
        if (handled) {
          log.info(TAG, 'Card action handled as permission response')
          return { toast: { type: 'success', content: '已处理' } }
        }
        log.info(TAG, 'Card action not recognized as permission response')
        return {}
      },

      'im.message.receive_v1': async (data: any) => {
        const msgId = data?.message?.message_id ?? 'no-id'
        const chatType = data?.message?.chat_type ?? 'unknown'
        const chatId = data?.message?.chat_id ?? 'unknown'
        const senderType = data?.sender?.sender_type ?? 'unknown'
        log.info(TAG, `EVENT raw: msgId=${msgId} chatType=${chatType} chatId=${chatId} senderType=${senderType}`)

        const parsed = parseEvent(data, this._botOpenId)
        if (!parsed) {
          log.info(TAG, `EVENT skipped: msgId=${msgId} (dup/bot/no-id)`)
          return {}
        }

        // Log gate result for debugging
        const gateResult = gate(parsed.chatId, parsed.chatType, parsed.senderId, parsed.mentionedBot, this._config)
        log.info(TAG, `GATE: chatId=${parsed.chatId} type=${parsed.chatType} mentioned=${parsed.mentionedBot} autoReply=${this._config.access.groupAutoReply.includes(parsed.chatId)} → ${gateResult.action}`)

        // Gate check
        const result = gate(
          parsed.chatId, parsed.chatType, parsed.senderId,
          parsed.mentionedBot, this._config
        )

        if (result.action === 'drop') {
          log.info(TAG, `DROPPED: ${parsed.messageId}`)
          return {}
        }

        if (result.action === 'pair') {
          await this._api.sendMessage(
            parsed.chatId,
            `Pairing required — run in Claude Code:\n\n/lark-customized:access pair ${result.code}`,
          )
          return {}
        }

        // Typing indicator (aligned with OpenClaw: "Typing" emoji on every message, removed on done)
        const reactionId = await this._api.addReaction(parsed.chatId, parsed.messageId, 'Typing')
        if (reactionId) {
          this._ackReactions.set(parsed.messageId, reactionId)
        }

        // Route
        onMessage(parsed)
        return {}
      },
    })

    // Start WebSocket
    const domain = this._config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
    this._wsClient = new Lark.WSClient({
      appId: this._config.appId,
      appSecret: this._config.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    })

    log.info(TAG, 'Connecting WebSocket...')
    await this._wsClient.start({ eventDispatcher: dispatcher })
    log.info(TAG, 'WebSocket connected')
  }

  async stop(): Promise<void> {
    // Lark WSClient doesn't expose a stop method; process exit cleans up
    log.info(TAG, 'Gateway stopping')
  }

  async sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<void> {
    await this._api.sendMessage(chatId, text, opts)
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null> {
    return await this._api.addReaction(chatId, messageId, emoji)
  }

  async removeReaction(chatId: string, messageId: string, reactionId: string): Promise<void> {
    await this._api.removeReaction(chatId, messageId, reactionId)
  }

  /** Remove ack reaction on completion (aligned with NeoClaw: just remove, no success emoji). */
  async ackDone(messageId: string): Promise<void> {
    const reactionId = this._ackReactions.get(messageId)
    if (reactionId) {
      await this._api.removeReaction('', messageId, reactionId)
      this._ackReactions.delete(messageId)
    }
  }

  async fetchMessages(chatId: string, limit: number) {
    return this._api.fetchMessages(chatId, limit)
  }

  async sendImage(chatId: string, imageKey: string, opts?: SendOpts): Promise<void> {
    await this._api.sendImage(chatId, imageKey, opts)
  }

  async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    return this._api.downloadImage(messageId, imageKey)
  }

  async uploadImage(imagePath: string): Promise<string> {
    return this._api.uploadImage(imagePath)
  }
}
