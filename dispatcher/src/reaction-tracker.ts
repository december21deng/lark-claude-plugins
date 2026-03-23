/**
 * Emoji reaction state machine for message processing lifecycle.
 *
 * Aligned with larksuite/openclaw-lark typing indicator pattern +
 * extended with multi-state transitions using valid Feishu emoji_type:
 *
 *   Typing   — message received, bot is processing (openclaw-lark default)
 *   OnIt     — worker assigned, actively working
 *   DONE     — reply sent successfully (auto-removed after 10s)
 *   FACEPALM — error occurred (persists)
 *
 * All emoji_type strings sourced from openclaw-lark VALID_FEISHU_EMOJI_TYPES:
 * https://github.com/larksuite/openclaw-lark/blob/main/src/messaging/outbound/reactions.ts
 *
 * No TTL sweep — cleanup is driven entirely by the message processing flow.
 * Safety nets: Map cap (1000), shutdown batch cleanup, catch-all in transition/cleanup.
 */

import type { LarkApi } from './gateways/lark/api.js'
import { log } from './utils/logger.js'

const TAG = 'reaction'
const MAP_CAP = 1000

interface ReactionEntry {
  chatId: string
  emoji: string
  reactionId: string | null
  createdAt: number
}

export class ReactionTracker {
  private _entries = new Map<string, ReactionEntry>()

  constructor(private _api: LarkApi) {}

  /**
   * Transition a message to a new emoji state.
   * Removes old emoji first, then adds new one.
   */
  async transition(messageId: string, chatId: string, newEmoji: string): Promise<void> {
    try {
      // Remove old emoji if exists
      const old = this._entries.get(messageId)
      if (old) {
        log.info(TAG, `${messageId}: removing old ${old.emoji} (reactionId=${old.reactionId})`)
        if (old.reactionId) {
          await this._api.removeReaction(old.chatId, messageId, old.reactionId).catch(e => {
            log.warn(TAG, `Failed to remove old ${old.emoji} from ${messageId}: ${e}`)
          })
        } else {
          log.warn(TAG, `${messageId}: old ${old.emoji} has no reactionId, cannot remove`)
        }
      }

      // Add new emoji
      const reactionId = await this._api.addReaction(chatId, messageId, newEmoji)

      this._entries.set(messageId, {
        chatId,
        emoji: newEmoji,
        reactionId,
        createdAt: Date.now(),
      })

      // DONE/FACEPALM are terminal states — keep emoji, just remove from tracker
      if (newEmoji === 'DONE' || newEmoji === 'FACEPALM') {
        this._entries.delete(messageId)
      }

      // Cap safety net
      if (this._entries.size > MAP_CAP) {
        this._evictOldest()
      }

      log.info(TAG, `${messageId}: → ${newEmoji}`)
    } catch (e) {
      log.error(TAG, `transition failed for ${messageId} → ${newEmoji}: ${e}`)
      // Always clean up map entry on failure to prevent leaks
      this._entries.delete(messageId)
    }
  }

  /**
   * Remove current emoji and delete entry.
   */
  async cleanup(messageId: string): Promise<void> {
    const entry = this._entries.get(messageId)
    if (!entry) return

    this._entries.delete(messageId)

    if (entry.reactionId) {
      await this._api.removeReaction(entry.chatId, messageId, entry.reactionId).catch(e => {
        log.warn(TAG, `cleanup remove failed for ${messageId}: ${e}`)
      })
    }
  }

  /**
   * Batch cleanup all entries (called on shutdown).
   */
  async dispose(): Promise<void> {
    const entries = [...this._entries.entries()]
    this._entries.clear()

    for (const [messageId, entry] of entries) {
      if (entry.reactionId) {
        await this._api.removeReaction(entry.chatId, messageId, entry.reactionId).catch(() => {})
      }
    }

    log.info(TAG, `Disposed ${entries.length} entries`)
  }

  private _evictOldest(): void {
    let oldestKey: string | null = null
    let oldestTs = Infinity
    for (const [key, entry] of this._entries) {
      if (entry.createdAt < oldestTs) {
        oldestTs = entry.createdAt
        oldestKey = key
      }
    }
    if (oldestKey) {
      this._entries.delete(oldestKey)
      log.warn(TAG, `Evicted oldest entry ${oldestKey} (cap reached)`)
    }
  }
}
