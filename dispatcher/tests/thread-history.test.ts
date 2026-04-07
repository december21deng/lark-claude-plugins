import { describe, test, expect } from 'bun:test'

/**
 * Tests for v5 thread history formatting.
 *
 * Replicates the formatting logic from router.ts as pure functions.
 */

// ── Types ──

interface ThreadMessage {
  messageId: string
  senderId: string
  senderName: string
  text: string
  createTime: number  // timestamp ms
  msgType: string
}

// ── Format thread history as XML ──

function formatThreadHistory(
  messages: ThreadMessage[],
  threadId: string,
  currentMessageId: string,
  botOpenId?: string,
): string {
  // Filter out current message
  const history = messages.filter(m => m.messageId !== currentMessageId)

  if (history.length === 0) return ''

  // Sort by time ascending
  history.sort((a, b) => a.createTime - b.createTime)

  const lines = history.map(m => {
    const time = formatTime(m.createTime)
    const name = m.senderId === botOpenId ? 'bot' : m.senderName
    return `[${time}] ${name}: ${m.text}`
  })

  return `<history thread_id="${threadId}">\n${lines.join('\n')}\n</history>`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Combine history + current message text for forwarding. */
function buildMessageWithHistory(
  historyXml: string,
  currentText: string,
): string {
  if (!historyXml) return currentText
  return `${historyXml}\n\n${currentText}`
}

// ══════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════

describe('thread history formatting', () => {
  const BOT_ID = 'ou_bot123'

  test('formats basic history', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_1', senderId: 'ou_user1', senderName: '张三', text: '帮我查一下销售数据', createTime: new Date('2024-01-01T14:01:00').getTime(), msgType: 'text' },
      { messageId: 'msg_2', senderId: BOT_ID, senderName: 'snow-claude', text: '上个月总销售额 320 万', createTime: new Date('2024-01-01T14:02:00').getTime(), msgType: 'text' },
      { messageId: 'msg_3', senderId: 'ou_user1', senderName: '张三', text: '那同比呢？', createTime: new Date('2024-01-01T14:05:00').getTime(), msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_thread1', 'msg_3', BOT_ID)
    expect(result).toContain('<history thread_id="tm_thread1">')
    expect(result).toContain('[14:01] 张三: 帮我查一下销售数据')
    expect(result).toContain('[14:02] bot: 上个月总销售额 320 万')
    expect(result).not.toContain('那同比呢？') // current message excluded
    expect(result).toContain('</history>')
  })

  test('current message excluded from history', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_1', senderId: 'ou_user1', senderName: '张三', text: 'hello', createTime: 1000, msgType: 'text' },
      { messageId: 'msg_2', senderId: 'ou_user1', senderName: '张三', text: 'world', createTime: 2000, msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_1', 'msg_2')
    expect(result).toContain('hello')
    expect(result).not.toContain('world')
  })

  test('empty when only current message exists', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_1', senderId: 'ou_user1', senderName: '张三', text: 'hello', createTime: 1000, msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_1', 'msg_1')
    expect(result).toBe('')
  })

  test('empty when no messages', () => {
    const result = formatThreadHistory([], 'tm_1', 'msg_1')
    expect(result).toBe('')
  })

  test('bot messages labeled as "bot"', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_1', senderId: BOT_ID, senderName: 'snow-claude', text: 'I am a bot', createTime: 1000, msgType: 'text' },
      { messageId: 'msg_2', senderId: 'ou_user1', senderName: '张三', text: 'ok', createTime: 2000, msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_1', 'msg_2', BOT_ID)
    expect(result).toContain('bot: I am a bot')
    expect(result).not.toContain('snow-claude')
  })

  test('without botOpenId, uses senderName for bot', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_1', senderId: BOT_ID, senderName: 'snow-claude', text: 'reply', createTime: 1000, msgType: 'text' },
      { messageId: 'msg_2', senderId: 'ou_user1', senderName: '张三', text: 'ok', createTime: 2000, msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_1', 'msg_2') // no botOpenId
    expect(result).toContain('snow-claude: reply')
  })

  test('messages sorted by time ascending', () => {
    const msgs: ThreadMessage[] = [
      { messageId: 'msg_3', senderId: 'ou_user1', senderName: 'C', text: 'third', createTime: 3000, msgType: 'text' },
      { messageId: 'msg_1', senderId: 'ou_user1', senderName: 'A', text: 'first', createTime: 1000, msgType: 'text' },
      { messageId: 'msg_2', senderId: 'ou_user1', senderName: 'B', text: 'second', createTime: 2000, msgType: 'text' },
      { messageId: 'msg_4', senderId: 'ou_user1', senderName: 'D', text: 'current', createTime: 4000, msgType: 'text' },
    ]

    const result = formatThreadHistory(msgs, 'tm_1', 'msg_4')
    const firstIdx = result.indexOf('first')
    const secondIdx = result.indexOf('second')
    const thirdIdx = result.indexOf('third')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })
})

describe('buildMessageWithHistory', () => {
  test('prepends history to current message', () => {
    const history = '<history thread_id="tm_1">\n[14:01] 张三: hello\n</history>'
    const result = buildMessageWithHistory(history, '请帮我看看')
    expect(result).toBe(`${history}\n\n请帮我看看`)
  })

  test('returns current message when no history', () => {
    const result = buildMessageWithHistory('', '请帮我看看')
    expect(result).toBe('请帮我看看')
  })
})

describe('trigger conditions', () => {
  // These test the condition logic, not actual API calls

  test('messages with threadId should trigger history fetch', () => {
    const hasThread = (threadId?: string) => !!threadId
    expect(hasThread('tm_thread123')).toBe(true)
  })

  test('messages without threadId should NOT trigger history fetch', () => {
    const hasThread = (threadId?: string) => !!threadId
    expect(hasThread(undefined)).toBe(false)
    expect(hasThread('')).toBe(false)
  })

  test('private chat messages should NOT trigger history fetch (no threadId)', () => {
    // Private chats don't have threadId
    const msg = { chatType: 'private' as const, threadId: undefined }
    expect(!!msg.threadId).toBe(false)
  })
})
