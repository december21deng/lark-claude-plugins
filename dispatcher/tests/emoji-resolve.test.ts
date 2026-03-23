import { describe, test, expect } from 'bun:test'

/**
 * Tests for emoji type resolution (api.ts resolveEmojiType logic).
 * Replicated here for isolated testing.
 */

const EMOJI_MAP: Record<string, string> = {
  '👀': 'GLANCE', '👍': 'THUMBSUP', '👎': 'ThumbsDown', '✅': 'DONE',
  '❌': 'CrossMark', '🎉': 'PARTY', '❤️': 'HEART', '💔': 'HEARTBROKEN',
  '🤔': 'THINKING', '😂': 'LOL', '😢': 'CRY', '😱': 'TERROR',
  '🤦': 'FACEPALM', '💪': 'MUSCLE', '🔥': 'Fire', '💯': 'Hundred',
  '👏': 'APPLAUSE', '🙏': 'THANKS', '😊': 'SMILE', '😄': 'LAUGH',
  '🤗': 'HUG', '💀': 'SKULL', '💩': 'POOP', '🌹': 'ROSE',
  '🍺': 'BEER', '🎂': 'CAKE', '🎁': 'GIFT', '☕': 'Coffee',
  '🏆': 'Trophy', '💣': 'BOMB', '🎵': 'Music', '📌': 'Pin',
  '⏰': 'Alarm', '📢': 'Loudspeaker', '✔️': 'CheckMark',
}

const ALIAS_MAP: Record<string, string> = {
  'eyes': 'GLANCE', 'thumbsup': 'THUMBSUP', 'thumbsdown': 'ThumbsDown',
  'done': 'DONE', 'ok': 'OK', 'facepalm': 'FACEPALM', 'heart': 'HEART',
  'fire': 'Fire', 'thinking': 'THINKING', 'party': 'PARTY', 'typing': 'Typing',
  'onit': 'OnIt', 'lgtm': 'LGTM', 'muscle': 'MUSCLE', 'applause': 'APPLAUSE',
  'clap': 'CLAP', 'praise': 'PRAISE', 'skull': 'SKULL', 'poop': 'POOP',
  'checkmark': 'CheckMark', 'crossmark': 'CrossMark', 'hundred': 'Hundred',
}

function resolveEmojiType(input: string): string {
  if (EMOJI_MAP[input]) return EMOJI_MAP[input]
  if (/^[A-Za-z0-9_]+$/.test(input)) {
    return ALIAS_MAP[input.toLowerCase()] ?? input
  }
  return input
}

describe('resolveEmojiType', () => {
  // ── Unicode emoji ──
  test('unicode 👀 → GLANCE', () => {
    expect(resolveEmojiType('👀')).toBe('GLANCE')
  })

  test('unicode 👍 → THUMBSUP', () => {
    expect(resolveEmojiType('👍')).toBe('THUMBSUP')
  })

  test('unicode ✅ → DONE', () => {
    expect(resolveEmojiType('✅')).toBe('DONE')
  })

  test('unicode 🤔 → THINKING', () => {
    expect(resolveEmojiType('🤔')).toBe('THINKING')
  })

  test('unicode 🔥 → Fire (mixed case)', () => {
    expect(resolveEmojiType('🔥')).toBe('Fire')
  })

  // ── Lowercase aliases ──
  test('alias "eyes" → GLANCE', () => {
    expect(resolveEmojiType('eyes')).toBe('GLANCE')
  })

  test('alias "thumbsup" → THUMBSUP', () => {
    expect(resolveEmojiType('thumbsup')).toBe('THUMBSUP')
  })

  test('alias "done" → DONE', () => {
    expect(resolveEmojiType('done')).toBe('DONE')
  })

  test('alias "typing" → Typing (mixed case)', () => {
    expect(resolveEmojiType('typing')).toBe('Typing')
  })

  test('alias "onit" → OnIt (mixed case)', () => {
    expect(resolveEmojiType('onit')).toBe('OnIt')
  })

  test('alias "fire" → Fire', () => {
    expect(resolveEmojiType('fire')).toBe('Fire')
  })

  // ── Already valid Feishu types (passthrough) ──
  test('valid type "DONE" passes through', () => {
    expect(resolveEmojiType('DONE')).toBe('DONE')
  })

  test('valid type "Typing" passes through', () => {
    expect(resolveEmojiType('Typing')).toBe('Typing')
  })

  test('valid type "OnIt" passes through', () => {
    expect(resolveEmojiType('OnIt')).toBe('OnIt')
  })

  test('valid type "FACEPALM" passes through', () => {
    expect(resolveEmojiType('FACEPALM')).toBe('FACEPALM')
  })

  test('valid type "THUMBSUP" passes through', () => {
    expect(resolveEmojiType('THUMBSUP')).toBe('THUMBSUP')
  })

  // ── Unknown input passthrough ──
  test('unknown type "CustomEmoji" passes through', () => {
    expect(resolveEmojiType('CustomEmoji')).toBe('CustomEmoji')
  })
})
