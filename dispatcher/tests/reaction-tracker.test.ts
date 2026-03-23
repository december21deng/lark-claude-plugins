import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * Tests for ReactionTracker logic.
 * Uses a mock LarkApi to verify transition/cleanup behavior
 * without hitting real Feishu APIs.
 */

// ── Mock LarkApi ──

interface ReactionCall {
  action: 'add' | 'remove'
  chatId: string
  messageId: string
  emoji?: string
  reactionId?: string
}

function createMockApi() {
  const calls: ReactionCall[] = []
  let nextId = 1

  return {
    calls,
    async addReaction(chatId: string, messageId: string, emoji: string): Promise<string | null> {
      const id = `reaction_${nextId++}`
      calls.push({ action: 'add', chatId, messageId, emoji, reactionId: id })
      return id
    },
    async removeReaction(chatId: string, messageId: string, reactionId: string): Promise<void> {
      calls.push({ action: 'remove', chatId, messageId, reactionId })
    },
  }
}

// ── Minimal ReactionTracker (same logic as src, isolated for testing) ──

interface ReactionEntry {
  chatId: string
  emoji: string
  reactionId: string | null
  createdAt: number
}

class TestReactionTracker {
  private _entries = new Map<string, ReactionEntry>()

  constructor(private _api: ReturnType<typeof createMockApi>) {}

  async transition(messageId: string, chatId: string, newEmoji: string): Promise<void> {
    const old = this._entries.get(messageId)
    if (old?.reactionId) {
      await this._api.removeReaction(old.chatId, messageId, old.reactionId)
    }
    const reactionId = await this._api.addReaction(chatId, messageId, newEmoji)
    this._entries.set(messageId, { chatId, emoji: newEmoji, reactionId, createdAt: Date.now() })
    // DONE/FACEPALM are terminal — keep emoji on message, remove from tracker
    if (newEmoji === 'DONE' || newEmoji === 'FACEPALM') {
      this._entries.delete(messageId)
    }
  }

  async cleanup(messageId: string): Promise<void> {
    const entry = this._entries.get(messageId)
    if (!entry) return
    this._entries.delete(messageId)
    if (entry.reactionId) {
      await this._api.removeReaction(entry.chatId, messageId, entry.reactionId)
    }
  }

  has(messageId: string): boolean { return this._entries.has(messageId) }
  getEmoji(messageId: string): string | undefined { return this._entries.get(messageId)?.emoji }
}

// ── Tests ──

describe('ReactionTracker', () => {
  let api: ReturnType<typeof createMockApi>
  let tracker: TestReactionTracker

  beforeEach(() => {
    api = createMockApi()
    tracker = new TestReactionTracker(api)
  })

  test('first transition adds emoji without removing', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]).toEqual({
      action: 'add', chatId: 'chat_1', messageId: 'msg_1',
      emoji: 'Typing', reactionId: 'reaction_1',
    })
    expect(tracker.getEmoji('msg_1')).toBe('Typing')
  })

  test('second transition removes old emoji then adds new', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    await tracker.transition('msg_1', 'chat_1', 'OnIt')

    expect(api.calls).toHaveLength(3)
    // 1. add Typing
    expect(api.calls[0].action).toBe('add')
    expect(api.calls[0].emoji).toBe('Typing')
    // 2. remove Typing
    expect(api.calls[1].action).toBe('remove')
    expect(api.calls[1].reactionId).toBe('reaction_1')
    // 3. add OnIt
    expect(api.calls[2].action).toBe('add')
    expect(api.calls[2].emoji).toBe('OnIt')

    expect(tracker.getEmoji('msg_1')).toBe('OnIt')
  })

  test('full lifecycle: Typing → OnIt → DONE', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    await tracker.transition('msg_1', 'chat_1', 'OnIt')
    await tracker.transition('msg_1', 'chat_1', 'DONE')

    // add Typing, remove Typing, add OnIt, remove OnIt, add DONE = 5 calls
    expect(api.calls).toHaveLength(5)
    // DONE is terminal: emoji stays on message, but tracker entry is removed
    expect(tracker.has('msg_1')).toBe(false)
  })

  test('cleanup removes current emoji and deletes entry', async () => {
    await tracker.transition('msg_1', 'chat_1', 'OnIt')
    await tracker.cleanup('msg_1')

    expect(api.calls).toHaveLength(2) // add + remove
    expect(api.calls[1].action).toBe('remove')
    expect(tracker.has('msg_1')).toBe(false)
  })

  test('cleanup on non-existent message is a no-op', async () => {
    await tracker.cleanup('msg_nonexistent')
    expect(api.calls).toHaveLength(0)
  })

  test('multiple messages tracked independently', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    await tracker.transition('msg_2', 'chat_1', 'Typing')
    await tracker.transition('msg_1', 'chat_1', 'DONE')

    // DONE is terminal — msg_1 removed from tracker, msg_2 still tracked
    expect(tracker.has('msg_1')).toBe(false)
    expect(tracker.getEmoji('msg_2')).toBe('Typing')
  })

  test('error transition: Typing → FACEPALM', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    await tracker.transition('msg_1', 'chat_1', 'FACEPALM')

    expect(api.calls).toHaveLength(3) // add Typing, remove Typing, add FACEPALM
    // FACEPALM is terminal: emoji stays, tracker entry removed
    expect(tracker.has('msg_1')).toBe(false)
  })

  // ── Terminal state tests ──

  test('DONE emoji is permanent — no remove call after transition', async () => {
    await tracker.transition('msg_1', 'chat_1', 'OnIt')
    await tracker.transition('msg_1', 'chat_1', 'DONE')

    // add OnIt, remove OnIt, add DONE = 3 calls. No remove for DONE.
    expect(api.calls).toHaveLength(3)
    expect(api.calls[2].action).toBe('add')
    expect(api.calls[2].emoji).toBe('DONE')
    // cleanup on DONE message is a no-op (entry already removed)
    await tracker.cleanup('msg_1')
    expect(api.calls).toHaveLength(3) // no extra remove call
  })

  test('FACEPALM emoji is permanent — cleanup is a no-op', async () => {
    await tracker.transition('msg_1', 'chat_1', 'FACEPALM')

    expect(api.calls).toHaveLength(1) // just add
    await tracker.cleanup('msg_1')
    expect(api.calls).toHaveLength(1) // no remove
  })

  test('DONE removes entry from tracker but not from message', async () => {
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    expect(tracker.has('msg_1')).toBe(true)

    await tracker.transition('msg_1', 'chat_1', 'DONE')
    expect(tracker.has('msg_1')).toBe(false)

    // A new transition on same messageId starts fresh (no old emoji to remove)
    await tracker.transition('msg_1', 'chat_1', 'Typing')
    // add Typing, remove Typing, add DONE, add Typing = 4 calls
    // Note: no remove before the last Typing because DONE cleared the entry
    expect(api.calls).toHaveLength(4)
  })
})
