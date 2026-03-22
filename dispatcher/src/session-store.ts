import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './config.js'
import { createDebouncedFlush } from './utils/debounced-flush.js'
import { log } from './utils/logger.js'

const SESSIONS_FILE = join(CONFIG_DIR, 'sessions.json')

export class SessionStore {
  private _sessions = new Map<string, string>()
  private _flush: () => void

  constructor() {
    this._flush = createDebouncedFlush(() => this._write(), 2000)
    this._load()
  }

  get(convKey: string): string | undefined {
    return this._sessions.get(convKey)
  }

  set(convKey: string, sessionId: string): void {
    this._sessions.set(convKey, sessionId)
    this._flush()
  }

  delete(convKey: string): void {
    this._sessions.delete(convKey)
    this._flush()
  }

  /** Force synchronous write (for shutdown). */
  flushSync(): void {
    this._write()
  }

  private _load(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) return
      const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8')) as Record<string, string>
      for (const [k, v] of Object.entries(data)) {
        this._sessions.set(k, v)
      }
      log.info('session-store', `Loaded ${this._sessions.size} session(s)`)
    } catch {
      log.warn('session-store', 'Failed to load sessions.json, starting fresh')
    }
  }

  private _write(): void {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      const data = Object.fromEntries(this._sessions)
      writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n')
    } catch (e) {
      log.error('session-store', `Failed to write sessions.json: ${e}`)
    }
  }
}
