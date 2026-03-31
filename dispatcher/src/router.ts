import type { ParsedMessage, Gateway, PendingMessage } from './types.js'
import type { LarkGateway } from './gateways/lark/ws.js'
import { Mutex } from './utils/mutex.js'
import { WorkerPool } from './pool.js'
import { log } from './utils/logger.js'

const TAG = 'router'

export class Router {
  private _queues = new Map<string, Mutex>()

  constructor(
    private _pool: WorkerPool,
    private _gateways: Map<string, Gateway>,
  ) {
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
      // Slash commands
      const cmd = parseCommand(msg.text)
      if (cmd) {
        await this._execCommand(cmd, msg, key)
        return
      }

      // Get worker
      const worker = await this._pool.getWorker(key)

      // v4: Pool exhausted — all workers busy, queue message
      if (!worker) {
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

      // Emoji state: OnIt — worker assigned
      const tracker = this._getTracker(msg.platform)
      if (tracker) {
        await tracker.transition(msg.messageId, msg.chatId, 'OnIt')
      }

      // Forward message to plugin
      log.info(TAG, `Forwarding to :${worker.port} for ${key}`)

      const resp = await fetch(`http://localhost:${worker.port}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: msg.text,
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

  private async _execCommand(cmd: string, msg: ParsedMessage, convKey: string): Promise<void> {
    const gw = this._gateways.get(msg.platform)
    if (!gw) return

    let reply = ''

    switch (cmd) {
      case 'clear':
      case 'new':
        await this._pool.clearConversation(convKey)
        reply = '✅ 对话已清除，下次消息将开始新对话。'
        break

      case 'status':
        reply = this._pool.status()
        break

      case 'help':
        reply = [
          '可用命令：',
          '/clear — 清除当前对话，重新开始',
          '/new — 同 /clear',
          '/status — 显示 worker 池状态',
          '/help — 显示此帮助',
        ].join('\n')
        break

      default:
        reply = `未知命令: /${cmd}`
    }

    await gw.sendMessage(msg.chatId, reply)
  }
}

// ── Helpers ──

function convKey(platform: string, chatId: string, threadId?: string): string {
  const base = `${platform}:${chatId}`
  return threadId ? `${base}_thread_${threadId}` : base
}

function parseCommand(_text: string): string | null {
  // Disabled: all /xxx messages are passed to workers as regular messages
  return null
}
