import { describe, test, expect } from 'bun:test'

// We test the convKey and parseCommand functions.
// These are not exported from router.ts, so we re-implement them here
// to test the logic without modifying the source.

function convKey(platform: string, chatId: string, threadId?: string): string {
  const base = `${platform}:${chatId}`
  return threadId ? `${base}_thread_${threadId}` : base
}

function parseCommand(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const cmd = trimmed.slice(1).split(/\s/)[0].toLowerCase()
  if (['clear', 'new', 'status', 'help'].includes(cmd)) return cmd
  return null
}

describe('convKey computation', () => {
  test('private chat: lark:chatId', () => {
    expect(convKey('lark', 'oc_abc123')).toBe('lark:oc_abc123')
  })

  test('group chat without thread: lark:chatId', () => {
    expect(convKey('lark', 'oc_group456')).toBe('lark:oc_group456')
  })

  test('group chat with thread: lark:chatId_thread_threadId', () => {
    expect(convKey('lark', 'oc_group456', 'omt_thread789')).toBe(
      'lark:oc_group456_thread_omt_thread789',
    )
  })

  test('different platform prefix', () => {
    expect(convKey('discord', 'chan_123')).toBe('discord:chan_123')
  })

  test('thread with no threadId is same as no thread', () => {
    expect(convKey('lark', 'oc_abc', undefined)).toBe('lark:oc_abc')
  })
})

describe('slash command parsing', () => {
  test('/clear is parsed', () => {
    expect(parseCommand('/clear')).toBe('clear')
  })

  test('/new is parsed', () => {
    expect(parseCommand('/new')).toBe('new')
  })

  test('/status is parsed', () => {
    expect(parseCommand('/status')).toBe('status')
  })

  test('/help is parsed', () => {
    expect(parseCommand('/help')).toBe('help')
  })

  test('slash commands are case-insensitive', () => {
    expect(parseCommand('/CLEAR')).toBe('clear')
    expect(parseCommand('/Help')).toBe('help')
  })

  test('slash command with trailing text', () => {
    expect(parseCommand('/clear all history')).toBe('clear')
  })

  test('slash command with leading whitespace', () => {
    expect(parseCommand('  /status')).toBe('status')
  })

  test('unknown slash commands return null', () => {
    expect(parseCommand('/unknown')).toBeNull()
    expect(parseCommand('/restart')).toBeNull()
    expect(parseCommand('/foo')).toBeNull()
  })

  test('non-slash text returns null', () => {
    expect(parseCommand('hello world')).toBeNull()
    expect(parseCommand('just a message')).toBeNull()
  })

  test('empty string returns null', () => {
    expect(parseCommand('')).toBeNull()
  })

  test('slash only returns null (not a known command)', () => {
    expect(parseCommand('/')).toBeNull()
  })
})
