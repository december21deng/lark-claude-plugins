import { describe, test, expect } from 'bun:test'

/**
 * Tests for reply threading and emoji batch processing logic (daemon.ts).
 */

// ── SenderMap type (matches daemon.ts) ──

type SenderEntry = { senderId: string; chatId: string; chatType: 'private' | 'group'; messageIds: string[] }
type SenderMap = Map<string, SenderEntry>

// ── Replicate the daemon reply_to fallback logic ──

function resolveReplyTo(args: {
  reply_to?: string
  message_id?: string
}, senderMap: SenderMap, convKey: string): string | undefined {
  const replyTo = args.reply_to
  const messageId = args.message_id
  const entry = senderMap.get(convKey)
  const latestMsgId = entry?.messageIds[entry.messageIds.length - 1]
  return replyTo || messageId || latestMsgId
}

// ── Replicate the daemon senderMap population logic ──

function trackMessage(senderMap: SenderMap, convKey: string, senderId: string, chatId: string, chatType: 'private' | 'group', messageId: string): void {
  const existing = senderMap.get(convKey)
  if (existing) {
    existing.messageIds.push(messageId)
  } else {
    senderMap.set(convKey, { senderId, chatId, chatType, messageIds: [messageId] })
  }
}

// ── Replicate manage_access DM-only check ──

function checkManageAccessAllowed(senderMap: SenderMap, convKey: string): { allowed: boolean; reason?: string } {
  const sender = senderMap.get(convKey)
  if (!sender) return { allowed: false, reason: 'no sender' }
  if (sender.chatType !== 'private') return { allowed: false, reason: 'not DM' }
  return { allowed: true }
}

// ── Replicate emoji batch processing on reply ──

function batchTransitionOnReply(senderMap: SenderMap, convKey: string): string[] {
  const entry = senderMap.get(convKey)
  if (!entry) return []
  const processed = [...entry.messageIds]
  entry.messageIds = [] // clear for next batch
  return processed
}

// ── Tests: reply_to fallback ──

describe('reply threading fallback', () => {
  test('uses reply_to when provided', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', chatType: 'private', messageIds: ['msg_original'] }]])
    const result = resolveReplyTo(
      { reply_to: 'msg_explicit', message_id: 'msg_meta' },
      senderMap, 'conv_1',
    )
    expect(result).toBe('msg_explicit')
  })

  test('falls back to message_id when no reply_to', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', chatType: 'private', messageIds: ['msg_original'] }]])
    const result = resolveReplyTo({ message_id: 'msg_meta' }, senderMap, 'conv_1')
    expect(result).toBe('msg_meta')
  })

  test('falls back to latest messageId from senderMap', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', chatType: 'private', messageIds: ['msg_A', 'msg_B'] }]])
    const result = resolveReplyTo({}, senderMap, 'conv_1')
    expect(result).toBe('msg_B') // latest message
  })

  test('returns undefined when nothing available', () => {
    const senderMap: SenderMap = new Map()
    const result = resolveReplyTo({}, senderMap, 'conv_unknown')
    expect(result).toBeUndefined()
  })

  test('reply_to takes precedence over senderMap', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', chatType: 'private', messageIds: ['msg_old'] }]])
    const result = resolveReplyTo({ reply_to: 'msg_new' }, senderMap, 'conv_1')
    expect(result).toBe('msg_new')
  })
})

// ── Tests: senderMap message tracking ──

describe('senderMap message tracking', () => {
  test('first message creates entry', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'private', 'msg_A')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A'])
  })

  test('second message appends to existing entry', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'private', 'msg_A')
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'private', 'msg_B')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A', 'msg_B'])
  })

  test('different convKeys are independent', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's1', 'c1', 'private', 'msg_A')
    trackMessage(senderMap, 'conv_2', 's2', 'c2', 'private', 'msg_B')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A'])
    expect(senderMap.get('conv_2')?.messageIds).toEqual(['msg_B'])
  })
})

// ── Tests: emoji batch processing ──

describe('emoji batch on reply', () => {
  test('single message: returns [A], clears list', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_A')

    const processed = batchTransitionOnReply(senderMap, 'conv_1')
    expect(processed).toEqual(['msg_A'])
    expect(senderMap.get('conv_1')?.messageIds).toEqual([]) // cleared
  })

  test('two messages merged reply: returns [A, B], clears list', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_B')

    const processed = batchTransitionOnReply(senderMap, 'conv_1')
    expect(processed).toEqual(['msg_A', 'msg_B'])
    expect(senderMap.get('conv_1')?.messageIds).toEqual([])
  })

  test('after batch clear, new messages accumulate fresh', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_B')

    // First reply clears A and B
    batchTransitionOnReply(senderMap, 'conv_1')

    // New message arrives
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_C')

    const processed = batchTransitionOnReply(senderMap, 'conv_1')
    expect(processed).toEqual(['msg_C'])
  })

  test('no entry returns empty array', () => {
    const senderMap: SenderMap = new Map()
    const processed = batchTransitionOnReply(senderMap, 'conv_unknown')
    expect(processed).toEqual([])
  })

  test('three messages, two replies scenario', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_B')

    // First reply: processes A and B
    const batch1 = batchTransitionOnReply(senderMap, 'conv_1')
    expect(batch1).toEqual(['msg_A', 'msg_B'])

    // Third message arrives after first reply
    trackMessage(senderMap, 'conv_1', 's', 'c', 'private', 'msg_C')

    // Second reply: processes only C
    const batch2 = batchTransitionOnReply(senderMap, 'conv_1')
    expect(batch2).toEqual(['msg_C'])
  })
})

// ── Tests: manage_access DM-only enforcement ──

describe('manage_access DM-only check', () => {
  test('allows manage_access in private chat', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_dm', 'ou_admin', 'chat_1', 'private', 'msg_1')
    const result = checkManageAccessAllowed(senderMap, 'conv_dm')
    expect(result.allowed).toBe(true)
  })

  test('rejects manage_access in group chat', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_group', 'ou_admin', 'chat_1', 'group', 'msg_1')
    const result = checkManageAccessAllowed(senderMap, 'conv_group')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('not DM')
  })

  test('rejects when no sender info', () => {
    const senderMap: SenderMap = new Map()
    const result = checkManageAccessAllowed(senderMap, 'conv_unknown')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('no sender')
  })
})
