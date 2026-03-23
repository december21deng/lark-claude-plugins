import { describe, test, expect } from 'bun:test'

/**
 * Tests for reply threading and emoji batch processing logic (daemon.ts).
 */

// ── SenderMap type (matches daemon.ts) ──

type SenderEntry = { senderId: string; chatId: string; messageIds: string[] }
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

function trackMessage(senderMap: SenderMap, convKey: string, senderId: string, chatId: string, messageId: string): void {
  const existing = senderMap.get(convKey)
  if (existing) {
    existing.messageIds.push(messageId)
  } else {
    senderMap.set(convKey, { senderId, chatId, messageIds: [messageId] })
  }
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
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', messageIds: ['msg_original'] }]])
    const result = resolveReplyTo(
      { reply_to: 'msg_explicit', message_id: 'msg_meta' },
      senderMap, 'conv_1',
    )
    expect(result).toBe('msg_explicit')
  })

  test('falls back to message_id when no reply_to', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', messageIds: ['msg_original'] }]])
    const result = resolveReplyTo({ message_id: 'msg_meta' }, senderMap, 'conv_1')
    expect(result).toBe('msg_meta')
  })

  test('falls back to latest messageId from senderMap', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', messageIds: ['msg_A', 'msg_B'] }]])
    const result = resolveReplyTo({}, senderMap, 'conv_1')
    expect(result).toBe('msg_B') // latest message
  })

  test('returns undefined when nothing available', () => {
    const senderMap: SenderMap = new Map()
    const result = resolveReplyTo({}, senderMap, 'conv_unknown')
    expect(result).toBeUndefined()
  })

  test('reply_to takes precedence over senderMap', () => {
    const senderMap: SenderMap = new Map([['conv_1', { senderId: 's', chatId: 'c', messageIds: ['msg_old'] }]])
    const result = resolveReplyTo({ reply_to: 'msg_new' }, senderMap, 'conv_1')
    expect(result).toBe('msg_new')
  })
})

// ── Tests: senderMap message tracking ──

describe('senderMap message tracking', () => {
  test('first message creates entry', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'msg_A')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A'])
  })

  test('second message appends to existing entry', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'msg_A')
    trackMessage(senderMap, 'conv_1', 'sender_1', 'chat_1', 'msg_B')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A', 'msg_B'])
  })

  test('different convKeys are independent', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's1', 'c1', 'msg_A')
    trackMessage(senderMap, 'conv_2', 's2', 'c2', 'msg_B')
    expect(senderMap.get('conv_1')?.messageIds).toEqual(['msg_A'])
    expect(senderMap.get('conv_2')?.messageIds).toEqual(['msg_B'])
  })
})

// ── Tests: emoji batch processing ──

describe('emoji batch on reply', () => {
  test('single message: returns [A], clears list', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_A')

    const processed = batchTransitionOnReply(senderMap, 'conv_1')
    expect(processed).toEqual(['msg_A'])
    expect(senderMap.get('conv_1')?.messageIds).toEqual([]) // cleared
  })

  test('two messages merged reply: returns [A, B], clears list', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_B')

    const processed = batchTransitionOnReply(senderMap, 'conv_1')
    expect(processed).toEqual(['msg_A', 'msg_B'])
    expect(senderMap.get('conv_1')?.messageIds).toEqual([])
  })

  test('after batch clear, new messages accumulate fresh', () => {
    const senderMap: SenderMap = new Map()
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_B')

    // First reply clears A and B
    batchTransitionOnReply(senderMap, 'conv_1')

    // New message arrives
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_C')

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
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_A')
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_B')

    // First reply: processes A and B
    const batch1 = batchTransitionOnReply(senderMap, 'conv_1')
    expect(batch1).toEqual(['msg_A', 'msg_B'])

    // Third message arrives after first reply
    trackMessage(senderMap, 'conv_1', 's', 'c', 'msg_C')

    // Second reply: processes only C
    const batch2 = batchTransitionOnReply(senderMap, 'conv_1')
    expect(batch2).toEqual(['msg_C'])
  })
})
