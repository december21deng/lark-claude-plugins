import type { ParsedMessage, Gateway, PendingMessage } from './types.js'
import type { LarkGateway } from './gateways/lark/ws.js'
import type { LarkApi } from './gateways/lark/api.js'
import { Mutex } from './utils/mutex.js'
import { WorkerPool } from './pool.js'
import { log } from './utils/logger.js'

const TAG = 'router'

export class Router {
  private _queues = new Map<string, Mutex>()
  private _botOpenId?: string

  constructor(
    private _pool: WorkerPool,
    private _gateways: Map<string, Gateway>,
    opts?: { botOpenId?: string },
  ) {
    this._botOpenId = opts?.botOpenId

    // v4: Set up drain callback for pending queue
    this._pool.setDrainCallback((pending: PendingMessage) => {
      log.info(TAG, `Draining pending message for ${pending.convKey}`)
      this.route(pending.msg).catch(e => log.error(TAG, `Drain route error: ${e}`))
    })
  }

  async route(msg: ParsedMessage): Promise<void> {
    const key = convKey(msg.platform, msg.chatId, msg.threadId)
    const queue = this._getQueue(key)

    await queue.acquire()
    try {
      // Get worker
      const result = await this._pool.getWorker(key)

      // v4: Pool exhausted — all workers busy, queue message
      if (!result) {
        const pos = this._pool.enqueuePending(msg, key)
        log.info(TAG, `Pool exhausted, queued ${key} at position ${pos}`)

        // Notify user
        const gw = this._gateways.get(msg.platform)
        if (gw) {
          await gw.sendMessage(msg.chatId, `⏳ 所有助手正忙，你的消息已排队（第 ${pos} 位），空闲后会自动处理。`, {
            replyToMessageId: msg.messageId,
          }).catch(e => log.error(TAG, `Failed to send queue notification: ${e}`))
        }
        return
      }

      const { worker, fresh } = result

      // Emoji state: OnIt — worker assigned
      const tracker = this._getTracker(msg.platform)
      if (tracker) {
        await tracker.transition(msg.messageId, msg.chatId, 'OnIt')
      }

      // v5: Fetch thread history if message has threadId
      // v6: Also fetch DM/chat history when worker is freshly assigned (after /clear)
      let content = msg.text
      if (msg.threadId) {
        try {
          const historyXml = await this._fetchThreadHistory(msg)
          if (historyXml) {
            content = `${historyXml}\n\n${content}`
            log.info(TAG, `Injected thread history for ${msg.threadId} (${historyXml.split('\n').length - 2} messages)`)
          }
        } catch (e) {
          log.warn(TAG, `Failed to fetch thread history for ${msg.threadId}: ${e}`)
        }
      } else if (fresh) {
        try {
          const historyXml = await this._fetchChatHistory(msg)
          if (historyXml) {
            content = `${historyXml}\n\n${content}`
            log.info(TAG, `Injected chat history for ${msg.chatId} (${historyXml.split('\n').length - 2} messages)`)
          }
        } catch (e) {
          log.warn(TAG, `Failed to fetch chat history for ${msg.chatId}: ${e}`)
        }
      }

      // Forward message to plugin
      log.info(TAG, `Forwarding to :${worker.port} for ${key}${fresh ? ' (fresh)' : ''}`)

      const resp = await fetch(`http://localhost:${worker.port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          platform: msg.platform,
          meta: {
            chat_id: msg.chatId,
            chat_type: msg.chatType,
            message_id: msg.messageId,
            user: msg.senderName,
            user_id: msg.senderId,
            ts: String(Date.now()),
            ...(msg.threadId ? { thread_id: msg.threadId } : {}),
            ...(msg.attachments?.length ? { attachments: msg.attachments.map(a => a.localPath ?? a.imageKey ?? a.fileKey ?? '').filter(Boolean).join('; ') } : {}),
          },
        }),
      })

      if (!resp.ok) {
        log.error(TAG, `Forward failed: ${resp.status} ${await resp.text()}`)
      }

      // v4: Mark worker as busy after successful forwarding
      this._pool.markBusy(key)
    } catch (e) {
      log.error(TAG, `Route error for ${key}: ${e}`)
      // Emoji state: Facepalm — routing error
      const tracker = this._getTracker(msg.platform)
      if (tracker) {
        await tracker.transition(msg.messageId, msg.chatId, 'FACEPALM').catch(() => {})
      }
    } finally {
      queue.release()
    }
  }

  // ── v6: Chat history (DM / group without thread) ──

  private async _fetchChatHistory(msg: ParsedMessage): Promise<string> {
    const gw = this._gateways.get(msg.platform)
    if (!gw || !('api' in gw)) return ''

    const api = (gw as LarkGateway).api as LarkApi
    const messages = await api.fetchChatMessages(msg.chatId, 20)

    if (!messages.length) return ''

    // Filter out current message and sort ascending
    const history = messages
      .filter(m => m.messageId !== msg.messageId)
      .sort((a, b) => a.createTime - b.createTime)

    if (!history.length) return ''

    const lines = history.map(m => {
      const time = formatTime(m.createTime)
      const name = m.senderId === this._botOpenId ? 'bot' : m.senderName
      return `[${time}] ${name}: ${m.text}`
    })

    return `<history chat_id="${msg.chatId}">\n${lines.join('\n')}\n</history>`
  }

  // ── v5: Thread history ──

  private async _fetchThreadHistory(msg: ParsedMessage): Promise<string> {
    if (!msg.threadId) return ''

    const gw = this._gateways.get(msg.platform)
    if (!gw || !('api' in gw)) return ''

    const api = (gw as LarkGateway).api as LarkApi
    const messages = await api.fetchThreadMessages(msg.threadId, 50)

    if (!messages.length) return ''

    // Filter out current message and sort ascending
    const history = messages
      .filter(m => m.messageId !== msg.messageId)
      .sort((a, b) => a.createTime - b.createTime)

    if (!history.length) return ''

    const lines = history.map(m => {
      const time = formatTime(m.createTime)
      const name = m.senderId === this._botOpenId ? 'bot' : m.senderName
      return `[${time}] ${name}: ${m.text}`
    })

    return `<history thread_id="${msg.threadId}">\n${lines.join('\n')}\n</history>`
  }

  // ── Private ──

  private _getTracker(platform: string) {
    const gw = this._gateways.get(platform)
    return gw && 'tracker' in gw ? (gw as LarkGateway).tracker : null
  }

  private _getQueue(key: string): Mutex {
    let q = this._queues.get(key)
    if (!q) {
      q = new Mutex()
      this._queues.set(key, q)
    }
    return q
  }
}

// ── Helpers ──

function convKey(platform: string, chatId: string, threadId?: string): string {
  const base = `${platform}:${chatId}`
  return threadId ? `${base}_thread_${threadId}` : base
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
