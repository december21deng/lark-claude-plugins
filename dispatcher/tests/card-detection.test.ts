import { describe, test, expect } from 'bun:test'

/**
 * Tests for card JSON detection and text extraction (api.ts).
 * Replicated here for isolated testing.
 */

// ── Card JSON detection (same logic as api.ts) ──

function detectCardJson(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false
  try {
    const parsed = JSON.parse(text)
    // v2.0 card
    if (parsed.schema === '2.0' && Array.isArray(parsed.body?.elements)) return true
    // v1 card
    if (parsed.config && parsed.header && Array.isArray(parsed.elements)) return true
    return false
  } catch {
    return false
  }
}

// ── Card text extraction (same logic as api.ts) ──

function collectElementText(elements: unknown[], parts: string[]): void {
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue
    const e = el as Record<string, unknown>
    switch (e.tag) {
      case 'markdown':
        if (e.content) parts.push(String(e.content))
        break
      case 'div':
        if (e.text && typeof e.text === 'object') {
          const t = e.text as Record<string, unknown>
          if (t.content) parts.push(String(t.content))
        }
        break
      case 'plain_text':
        if (e.content) parts.push(String(e.content))
        break
      case 'column_set':
        if (Array.isArray(e.columns)) {
          for (const col of e.columns) {
            if (col && typeof col === 'object' && Array.isArray((col as any).elements)) {
              collectElementText((col as any).elements, parts)
            }
          }
        }
        break
      case 'collapsible_panel':
        if (Array.isArray(e.elements)) {
          collectElementText(e.elements as unknown[], parts)
        }
        break
    }
  }
}

function extractCardText(jsonStr: string): string {
  try {
    const card = JSON.parse(jsonStr)
    const parts: string[] = []
    const title = card.header?.title?.content ?? card.header?.title?.text
    if (title) parts.push(`**${title}**`)
    const elements = card.body?.elements ?? card.elements ?? []
    collectElementText(elements, parts)
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

// ── Tests: card JSON detection ──

describe('card JSON detection', () => {
  test('v2.0 card with schema + body.elements is detected', () => {
    const card = JSON.stringify({
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: 'hello' }] },
    })
    expect(detectCardJson(card)).toBe(true)
  })

  test('v1 card with config + header + elements is detected', () => {
    const card = JSON.stringify({
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Title' } },
      elements: [{ tag: 'markdown', content: 'body' }],
    })
    expect(detectCardJson(card)).toBe(true)
  })

  test('plain text is not detected as card', () => {
    expect(detectCardJson('hello world')).toBe(false)
  })

  test('JSON without card structure is not detected', () => {
    expect(detectCardJson(JSON.stringify({ text: 'hello' }))).toBe(false)
  })

  test('JSON with only schema but no body.elements is not detected', () => {
    expect(detectCardJson(JSON.stringify({ schema: '2.0' }))).toBe(false)
  })

  test('JSON with schema + body but elements not array is not detected', () => {
    expect(detectCardJson(JSON.stringify({ schema: '2.0', body: { elements: 'not array' } }))).toBe(false)
  })

  test('invalid JSON is not detected', () => {
    expect(detectCardJson('{invalid json')).toBe(false)
  })

  test('empty string is not detected', () => {
    expect(detectCardJson('')).toBe(false)
  })

  test('JSON with only config (no header) is not detected', () => {
    expect(detectCardJson(JSON.stringify({ config: {}, elements: [] }))).toBe(false)
  })
})

// ── Tests: card text extraction ──

describe('extractCardText', () => {
  test('extracts header title', () => {
    const card = JSON.stringify({
      header: { title: { content: 'My Report' } },
      body: { elements: [] },
    })
    expect(extractCardText(card)).toBe('**My Report**')
  })

  test('extracts markdown content', () => {
    const card = JSON.stringify({
      body: { elements: [{ tag: 'markdown', content: '# Hello\nWorld' }] },
    })
    expect(extractCardText(card)).toBe('# Hello\nWorld')
  })

  test('extracts div text', () => {
    const card = JSON.stringify({
      body: { elements: [{ tag: 'div', text: { content: 'div content' } }] },
    })
    expect(extractCardText(card)).toBe('div content')
  })

  test('extracts from column_set', () => {
    const card = JSON.stringify({
      body: {
        elements: [{
          tag: 'column_set',
          columns: [
            { elements: [{ tag: 'markdown', content: 'col1' }] },
            { elements: [{ tag: 'markdown', content: 'col2' }] },
          ],
        }],
      },
    })
    expect(extractCardText(card)).toBe('col1\n\ncol2')
  })

  test('extracts from collapsible_panel', () => {
    const card = JSON.stringify({
      body: {
        elements: [{
          tag: 'collapsible_panel',
          elements: [{ tag: 'markdown', content: 'hidden content' }],
        }],
      },
    })
    expect(extractCardText(card)).toBe('hidden content')
  })

  test('combines header + body elements', () => {
    const card = JSON.stringify({
      header: { title: { content: 'Title' } },
      body: {
        elements: [
          { tag: 'markdown', content: 'paragraph 1' },
          { tag: 'markdown', content: 'paragraph 2' },
        ],
      },
    })
    expect(extractCardText(card)).toBe('**Title**\n\nparagraph 1\n\nparagraph 2')
  })

  test('returns empty string for invalid JSON', () => {
    expect(extractCardText('{bad')).toBe('')
  })

  test('returns empty string for card with no extractable content', () => {
    const card = JSON.stringify({ body: { elements: [{ tag: 'hr' }] } })
    expect(extractCardText(card)).toBe('')
  })

  test('skips null/undefined elements', () => {
    const card = JSON.stringify({
      body: { elements: [null, undefined, { tag: 'markdown', content: 'valid' }] },
    })
    expect(extractCardText(card)).toBe('valid')
  })
})
