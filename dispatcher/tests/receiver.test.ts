import { describe, test, expect, beforeEach } from 'bun:test'

// We test the pure functions from receiver.ts logic.
// Since parseEvent uses the module-level dedup singleton, we replicate the
// extraction and gate logic here for isolated testing.

// ── Text extraction (same logic as receiver.ts) ──

function extractText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (msgType === 'text') return (parsed['text'] as string) || ''
    if (msgType === 'post') return extractRichText(content)
    return content
  } catch { return content }
}

function extractRichText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string
      content?: Array<Array<{
        tag: string; text?: string; href?: string
        user_id?: string; user_name?: string
        language?: string; image_key?: string; style?: string[]
      }>>
    }
    let text = parsed.title ? `# ${parsed.title}\n\n` : ''
    for (const para of parsed.content ?? []) {
      for (const el of para) {
        const styles = el.style ?? []
        if (el.tag === 'text') text += applyStyles(el.text ?? '', styles)
        else if (el.tag === 'code_block') text += `\`\`\`${el.language ?? ''}\n${el.text ?? ''}\`\`\``
        else if (el.tag === 'a') text += `[${el.text ?? el.href ?? ''}](${el.href ?? ''})`
        else if (el.tag === 'at') text += el.user_name ? `@${el.user_name}` : (el.user_id ?? '')
        else if (el.tag === 'img') text += '[图片]'
      }
      text += '\n'
    }
    return text.trim() || '[富文本消息]'
  } catch { return '[富文本消息]' }
}

function applyStyles(text: string, styles: string[]): string {
  if (!text || !styles.length) return text
  let r = text
  if (styles.includes('bold')) r = `**${r}**`
  if (styles.includes('italic')) r = `*${r}*`
  if (styles.includes('underline')) r = `<u>${r}</u>`
  if (styles.includes('lineThrough')) r = `~~${r}~~`
  return r
}

// ── Image key extraction ──

function extractImageKey(content: string, msgType: string): string | undefined {
  try {
    const p = JSON.parse(content) as Record<string, unknown>
    if (msgType === 'image') return p['image_key'] as string | undefined
    return undefined
  } catch { return undefined }
}

// ── Bot mention detection ──

function isBotMentioned(event: any, botOpenId?: string): boolean {
  if (!botOpenId) return false
  return (event.message?.mentions ?? []).some((m: any) => m.id?.open_id === botOpenId)
}

// ── Dedup (isolated instance) ──

function createDedup() {
  const seen = new Set<string>()
  return {
    markSeen(id: string): boolean {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    },
  }
}

// ── Tests ──

describe('message text extraction', () => {
  test('text message extraction', () => {
    const content = JSON.stringify({ text: 'hello world' })
    expect(extractText(content, 'text')).toBe('hello world')
  })

  test('empty text message', () => {
    const content = JSON.stringify({ text: '' })
    expect(extractText(content, 'text')).toBe('')
  })

  test('text message with mentions', () => {
    const content = JSON.stringify({ text: '@_user_1 hello there' })
    expect(extractText(content, 'text')).toBe('@_user_1 hello there')
  })

  test('invalid JSON returns raw content', () => {
    expect(extractText('not json', 'text')).toBe('not json')
  })
})

describe('image message detection', () => {
  test('image message extracts image_key', () => {
    const content = JSON.stringify({ image_key: 'img_v3_abcd' })
    expect(extractImageKey(content, 'image')).toBe('img_v3_abcd')
  })

  test('non-image message returns undefined', () => {
    const content = JSON.stringify({ text: 'hello' })
    expect(extractImageKey(content, 'text')).toBeUndefined()
  })

  test('image message without key returns undefined', () => {
    const content = JSON.stringify({})
    expect(extractImageKey(content, 'image')).toBeUndefined()
  })
})

describe('post (rich text) parsing', () => {
  test('simple rich text with title', () => {
    const content = JSON.stringify({
      title: 'My Title',
      content: [
        [{ tag: 'text', text: 'Hello ' }, { tag: 'text', text: 'world', style: ['bold'] }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toContain('# My Title')
    expect(result).toContain('Hello ')
    expect(result).toContain('**world**')
  })

  test('rich text without title', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'text', text: 'Just text' }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toBe('Just text')
  })

  test('rich text with link', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'a', text: 'Click here', href: 'https://example.com' }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toBe('[Click here](https://example.com)')
  })

  test('rich text with at-mention', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'at', user_name: 'Alice' }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toBe('@Alice')
  })

  test('rich text with image placeholder', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'img', image_key: 'img_abc' }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toBe('[图片]')
  })

  test('rich text with code block', () => {
    const content = JSON.stringify({
      content: [
        [{ tag: 'code_block', language: 'python', text: 'print("hi")' }],
      ],
    })
    const result = extractText(content, 'post')
    expect(result).toContain('```python')
    expect(result).toContain('print("hi")')
  })

  test('empty rich text returns fallback', () => {
    const content = JSON.stringify({ content: [] })
    const result = extractText(content, 'post')
    expect(result).toBe('[富文本消息]')
  })
})

describe('bot mention detection', () => {
  const BOT_ID = 'ou_bot_123'

  test('bot is mentioned', () => {
    const event = {
      message: {
        mentions: [{ id: { open_id: BOT_ID }, key: '@_user_1' }],
      },
    }
    expect(isBotMentioned(event, BOT_ID)).toBe(true)
  })

  test('bot is not mentioned', () => {
    const event = {
      message: {
        mentions: [{ id: { open_id: 'ou_other' }, key: '@_user_1' }],
      },
    }
    expect(isBotMentioned(event, BOT_ID)).toBe(false)
  })

  test('no mentions at all', () => {
    const event = { message: {} }
    expect(isBotMentioned(event, BOT_ID)).toBe(false)
  })

  test('no botOpenId returns false', () => {
    const event = {
      message: {
        mentions: [{ id: { open_id: 'ou_bot_123' }, key: '@_user_1' }],
      },
    }
    expect(isBotMentioned(event, undefined)).toBe(false)
  })
})

describe('message dedup', () => {
  test('first message is new', () => {
    const dedup = createDedup()
    expect(dedup.markSeen('msg_001')).toBe(true)
  })

  test('same message is duplicate', () => {
    const dedup = createDedup()
    dedup.markSeen('msg_001')
    expect(dedup.markSeen('msg_001')).toBe(false)
  })

  test('different messages are both new', () => {
    const dedup = createDedup()
    expect(dedup.markSeen('msg_a')).toBe(true)
    expect(dedup.markSeen('msg_b')).toBe(true)
  })
})
