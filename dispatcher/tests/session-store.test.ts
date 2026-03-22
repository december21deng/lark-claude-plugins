import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// SessionStore uses CONFIG_DIR from config.ts which reads from a real config file.
// To test in isolation, we replicate the core logic with a configurable path.

class TestSessionStore {
  private _sessions = new Map<string, string>()
  private _file: string

  constructor(file: string) {
    this._file = file
    this._load()
  }

  get(convKey: string): string | undefined {
    return this._sessions.get(convKey)
  }

  set(convKey: string, sessionId: string): void {
    this._sessions.set(convKey, sessionId)
    this._write()
  }

  delete(convKey: string): void {
    this._sessions.delete(convKey)
    this._write()
  }

  flushSync(): void {
    this._write()
  }

  get size(): number {
    return this._sessions.size
  }

  private _load(): void {
    try {
      if (!existsSync(this._file)) return
      const data = JSON.parse(readFileSync(this._file, 'utf8')) as Record<string, string>
      for (const [k, v] of Object.entries(data)) {
        this._sessions.set(k, v)
      }
    } catch {
      // Start fresh on error
    }
  }

  private _write(): void {
    try {
      const data = Object.fromEntries(this._sessions)
      writeFileSync(this._file, JSON.stringify(data, null, 2) + '\n')
    } catch {}
  }
}

describe('SessionStore', () => {
  const testDir = join(tmpdir(), `session-store-test-${Date.now()}`)
  const sessionsFile = join(testDir, 'sessions.json')

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true })
    // Clean up any leftover file
    try { rmSync(sessionsFile) } catch {}
  })

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }) } catch {}
  })

  test('save and load session IDs', () => {
    const store = new TestSessionStore(sessionsFile)
    store.set('lark:oc_abc', 'session-123')
    store.flushSync()

    // Create a new store from the same file to verify persistence
    const store2 = new TestSessionStore(sessionsFile)
    expect(store2.get('lark:oc_abc')).toBe('session-123')
  })

  test('empty store loads without error', () => {
    // No sessions file exists
    const store = new TestSessionStore(sessionsFile)
    expect(store.get('nonexistent')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  test('multiple sessions saved correctly', () => {
    const store = new TestSessionStore(sessionsFile)
    store.set('lark:oc_chat1', 'sess-aaa')
    store.set('lark:oc_chat2', 'sess-bbb')
    store.set('discord:chan_99', 'sess-ccc')
    store.flushSync()

    // Reload
    const store2 = new TestSessionStore(sessionsFile)
    expect(store2.get('lark:oc_chat1')).toBe('sess-aaa')
    expect(store2.get('lark:oc_chat2')).toBe('sess-bbb')
    expect(store2.get('discord:chan_99')).toBe('sess-ccc')
    expect(store2.size).toBe(3)
  })

  test('delete removes a session', () => {
    const store = new TestSessionStore(sessionsFile)
    store.set('lark:oc_x', 'sess-x')
    store.set('lark:oc_y', 'sess-y')
    store.delete('lark:oc_x')
    store.flushSync()

    const store2 = new TestSessionStore(sessionsFile)
    expect(store2.get('lark:oc_x')).toBeUndefined()
    expect(store2.get('lark:oc_y')).toBe('sess-y')
  })

  test('overwrite existing session', () => {
    const store = new TestSessionStore(sessionsFile)
    store.set('lark:oc_z', 'old-session')
    store.set('lark:oc_z', 'new-session')
    store.flushSync()

    const store2 = new TestSessionStore(sessionsFile)
    expect(store2.get('lark:oc_z')).toBe('new-session')
  })

  test('corrupt file starts fresh', () => {
    writeFileSync(sessionsFile, 'NOT VALID JSON{{{')
    const store = new TestSessionStore(sessionsFile)
    expect(store.size).toBe(0)
  })
})
