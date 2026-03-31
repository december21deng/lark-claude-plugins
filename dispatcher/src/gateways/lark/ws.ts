import * as Lark from '@larksuiteoapi/node-sdk'
import type { LarkConfig, Gateway, ParsedMessage, SendOpts, AccessConfig } from '../../types.js'
import { parseEvent, gate } from './receiver.js'
import { LarkApi } from './api.js'
import { ReactionTracker } from '../../reaction-tracker.js'
import { handleCardAction } from '../../permission.js'
import { log } from '../../utils/logger.js'

const TAG = 'lark-gw'

export class LarkGateway implements Gateway {
  readonly platform = 'lark'

  private _wsClient: Lark.WSClient | null = null
  private _api: LarkApi
  private _botOpenId?: string
  private _config: LarkConfig
  private _tracker: ReactionTracker

  /** Optional live access config override (from AdminManager). */
  private _liveAccessConfig?: () => AccessConfig

  constructor(config: LarkConfig) {
    this._config = config
    this._api = new LarkApi(config)
    this._tracker = new ReactionTracker(this._api)
  }

  get api(): LarkApi { return this._api }
  get tracker(): ReactionTracker { return this._tracker }

  /** Set a function that returns live access config (used by AdminManager). */
  setLiveAccessConfig(fn: () => AccessConfig): void {
    this._liveAccessConfig = fn
  }

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
      // Suppress "no handle" warnings for reaction events (we don't need to act on them)
      'im.message.reaction.created_v1': async () => ({}),
      'im.message.reaction.deleted_v1': async () => ({}),

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

        // Gate check (use live access config if available)
        const accessConfig = this._liveAccessConfig ? this._liveAccessConfig() : this._config.access
        const result = gate(
          parsed.chatId, parsed.chatType, parsed.senderId,
          parsed.mentionedBot, accessConfig
        )
        log.info(TAG, `GATE: chatId=${parsed.chatId} type=${parsed.chatType} mentioned=${parsed.mentionedBot} → ${result.action}`)

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

        // Emoji state: Typing — message received (aligned with openclaw-lark)
        await this._tracker.transition(parsed.messageId, parsed.chatId, 'Typing')

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
    await this._tracker.dispose()
    log.info(TAG, 'Gateway stopping')
  }

  async sendMessage(chatId: string, text: string, opts?: SendOpts): Promise<void> {
    await this._api.sendMessage(chatId, text, opts)
  }

  async sendCard(chatId: string, card: Record<string, unknown>, opts?: SendOpts): Promise<void> {
    await this._api.sendCardObject(chatId, card, { replyToMessageId: opts?.replyToMessageId })
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null> {
    return await this._api.addReaction(chatId, messageId, emoji)
  }

  async removeReaction(chatId: string, messageId: string, reactionId: string): Promise<void> {
    await this._api.removeReaction(chatId, messageId, reactionId)
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
