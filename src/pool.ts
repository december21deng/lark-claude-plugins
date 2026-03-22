import { execSync, spawnSync } from 'child_process'
import { homedir } from 'os'
import type { Worker, PoolConfig, ClaudeConfig } from './types.js'
import { SessionStore } from './session-store.js'
import { log } from './utils/logger.js'

const TAG = 'pool'
const TMUX_PREFIX = 'lark-worker'
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes per worker
const MAX_RETRIES = 3

export class WorkerPool {
  private _workers: Worker[]
  private _assignments = new Map<string, number>()
  private _lastUsed = new Map<string, number>()
  private _sessions: SessionStore
  private _startingInBackground = false

  constructor(
    private _poolConfig: PoolConfig,
    private _claudeConfig: ClaudeConfig,
  ) {
    this._sessions = new SessionStore()

    this._workers = Array.from({ length: _poolConfig.maxWorkers }, (_, i) => ({
      proc: null,
      port: _poolConfig.basePort + i,
      convKey: null,
      sessionId: null,
      startedAt: 0,
      ready: false,
      pid: null,
    }))

    log.info(TAG, `Pool initialized: ${_poolConfig.maxWorkers} workers, ports ${_poolConfig.basePort}-${_poolConfig.basePort + _poolConfig.maxWorkers - 1}`)
  }

  /** Pre-trust workspace and kill leftover sessions. Then start workers in background. */
  async init(): Promise<void> {
    // Pre-trust
    log.info(TAG, 'Pre-trusting workspace via --print mode...')
    try {
      spawnSync(this._claudeConfig.bin, ['-p', 'ok'], {
        cwd: homedir(),
        stdio: 'ignore',
        timeout: 15000,
      })
    } catch (e) {
      log.warn(TAG, `Pre-trust failed (non-critical): ${e}`)
    }

    // Kill leftover tmux sessions
    for (let i = 0; i < this._workers.length; i++) {
      this._killTmux(i)
    }

    // Start workers in background (daemon can accept messages immediately)
    this._startingInBackground = true
    this._startAllInBackground()
  }

  /** Start all workers sequentially in background. */
  private async _startAllInBackground(): Promise<void> {
    for (let i = 0; i < this._workers.length; i++) {
      const ok = await this._startWorkerWithRetry(i)
      if (ok) {
        const readyCount = this._workers.filter(w => w.ready).length
        log.info(TAG, `Progress: ${readyCount}/${this._workers.length} workers ready`)
      }
    }

    const readyCount = this._workers.filter(w => w.ready).length
    log.info(TAG, `All workers started: ${readyCount}/${this._workers.length} ready`)
    this._startingInBackground = false
  }

  /** Start a worker with retries. Returns true if successful. */
  private async _startWorkerWithRetry(idx: number, sessionId?: string | null): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log.info(TAG, `Starting worker[${idx}] (attempt ${attempt}/${MAX_RETRIES})`)

      this._killTmux(idx)
      await this._sleep(500)

      const ok = await this._startWorker(idx, sessionId)
      if (ok) return true

      // Diagnose failure
      const diagnosis = this._diagnoseWorker(idx)
      log.error(TAG, `Worker[${idx}] failed to start: ${diagnosis}`)

      if (attempt < MAX_RETRIES) {
        log.info(TAG, `Retrying worker[${idx}]...`)
      }
    }

    log.error(TAG, `Worker[${idx}] failed after ${MAX_RETRIES} attempts, skipping`)
    return false
  }

  /** Start a single worker. Returns true if healthy within timeout. */
  private async _startWorker(idx: number, sessionId?: string | null): Promise<boolean> {
    const name = this._tmuxName(idx)
    const cmd = this._buildClaudeCmd(idx, sessionId)

    // Create tmux session
    spawnSync('tmux', [
      'new-session', '-d', '-s', name,
      '-x', '120', '-y', '30',
      'bash', '-c', cmd,
    ], {
      cwd: homedir(),
      stdio: 'ignore',
    })

    // Auto-confirm prompts
    for (const delay of [5000, 8000, 12000, 20000]) {
      setTimeout(() => {
        if (this._isTmuxAlive(idx)) {
          spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' })
        }
      }, delay)
    }

    // Wait for health check (1s polling, 5min timeout)
    const ok = await this._waitForReady(idx, STARTUP_TIMEOUT_MS)

    if (ok) {
      this._workers[idx].ready = true
      this._workers[idx].startedAt = Date.now()
      log.info(TAG, `Worker[${idx}] ready on :${this._workers[idx].port}`)
    }

    return ok
  }

  /** Diagnose why a worker failed to start. */
  private _diagnoseWorker(idx: number): string {
    const name = this._tmuxName(idx)

    if (!this._isTmuxAlive(idx)) {
      return 'tmux session died (Claude CLI crashed or exited)'
    }

    // Capture tmux terminal output for diagnosis
    try {
      const result = spawnSync('tmux', ['capture-pane', '-t', name, '-p'], {
        encoding: 'utf-8',
        timeout: 5000,
      })
      const output = (result.stdout ?? '').toString()
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // strip ANSI
        .trim()
        .split('\n')
        .slice(-10)  // last 10 lines
        .join(' | ')
      return `tmux alive but not ready. Terminal: ${output || '(empty)'}`
    } catch {
      return 'tmux alive but could not capture terminal output'
    }
  }

  /** Get or assign a worker for a conversation. */
  async getWorker(convKey: string): Promise<Worker> {
    // 1. Already assigned → reuse (with health check)
    const existingIdx = this._assignments.get(convKey)
    if (existingIdx !== undefined) {
      const w = this._workers[existingIdx]
      if (w.ready && await this._isHealthy(existingIdx)) {
        this._lastUsed.set(convKey, Date.now())
        log.info(TAG, `Reusing worker[${existingIdx}] for ${convKey}`)
        return w
      }
      log.warn(TAG, `Worker[${existingIdx}] not healthy, restarting for ${convKey}`)
      this._assignments.delete(convKey)
      await this._startWorkerWithRetry(existingIdx, this._sessions.get(convKey))
      const w2 = this._workers[existingIdx]
      w2.convKey = convKey
      this._assignments.set(convKey, existingIdx)
      this._lastUsed.set(convKey, Date.now())
      return w2
    }

    // 2. Find idle ready worker
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      if (w.convKey !== null) continue
      if (!w.ready || !await this._isHealthy(i)) continue
      // Healthy and idle — assign
      w.convKey = convKey
      w.startedAt = Date.now()
      this._assignments.set(convKey, i)
      this._lastUsed.set(convKey, Date.now())
      log.info(TAG, `Assigned idle worker[${i}] :${w.port} to ${convKey}`)
      return w
    }

    // 3. Find idle NOT ready worker → start it
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      if (w.convKey !== null) continue
      // Not ready, try to start it now
      log.info(TAG, `Worker[${i}] not ready, starting on demand for ${convKey}`)
      const sessionId = this._sessions.get(convKey) ?? null
      await this._startWorkerWithRetry(i, sessionId)
      w.convKey = convKey
      w.sessionId = sessionId
      this._assignments.set(convKey, i)
      this._lastUsed.set(convKey, Date.now())
      return w
    }

    // 4. Pool full → evict oldest, restart with new session
    const victimKey = this._findOldestUsedKey()
    if (victimKey) {
      const victimIdx = this._assignments.get(victimKey)!
      log.info(TAG, `Evicting worker[${victimIdx}] (${victimKey}) for ${convKey}`)

      const victimWorker = this._workers[victimIdx]
      if (victimWorker.sessionId) {
        this._sessions.set(victimKey, victimWorker.sessionId)
      }
      this._assignments.delete(victimKey)

      const sessionId = this._sessions.get(convKey) ?? null
      await this._startWorkerWithRetry(victimIdx, sessionId)
      const w = this._workers[victimIdx]
      w.convKey = convKey
      w.sessionId = sessionId
      this._assignments.set(convKey, victimIdx)
      this._lastUsed.set(convKey, Date.now())
      return w
    }

    throw new Error('No workers available')
  }

  /** Terminate a specific conversation's worker and delete its session. */
  async clearConversation(convKey: string): Promise<void> {
    const idx = this._assignments.get(convKey)
    if (idx !== undefined) {
      this._assignments.delete(convKey)
      this._workers[idx].convKey = null
      this._workers[idx].ready = false
      await this._startWorkerWithRetry(idx)
    }
    this._sessions.delete(convKey)
    this._lastUsed.delete(convKey)
    log.info(TAG, `Cleared conversation: ${convKey}`)
  }

  /** Graceful shutdown: save all sessions, kill all workers. */
  async shutdown(): Promise<void> {
    log.info(TAG, 'Shutting down pool...')
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      if (w.convKey && w.sessionId) {
        this._sessions.set(w.convKey, w.sessionId)
      }
      this._killTmux(i)
    }
    this._sessions.flushSync()
    log.info(TAG, 'Pool shut down')
  }

  /** Update sessionId for a convKey. */
  updateSessionId(convKey: string, sessionId: string): void {
    this._sessions.set(convKey, sessionId)
    const idx = this._assignments.get(convKey)
    if (idx !== undefined) {
      this._workers[idx].sessionId = sessionId
    }
  }

  /** Get pool status. */
  status(): string {
    const readyCount = this._workers.filter(w => w.ready).length
    const lines: string[] = [`Workers: ${readyCount}/${this._workers.length} ready${this._startingInBackground ? ' (starting...)' : ''}`]
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      const alive = this._isTmuxAlive(i) ? '●' : '○'
      const status = w.ready ? '' : ' [starting]'
      if (w.convKey) {
        const lastUsed = this._lastUsed.get(w.convKey)
        const idle = lastUsed ? Math.round((Date.now() - lastUsed) / 1000) : 0
        lines.push(`  ${alive} [${i}] :${w.port} → ${w.convKey} (idle ${idle}s)${status}`)
      } else {
        lines.push(`  ${alive} [${i}] :${w.port} → (available)${status}`)
      }
    }
    lines.push(`Sessions stored: ${this._sessions['_sessions'].size}`)
    return lines.join('\n')
  }

  // ── Private ──

  private _tmuxName(idx: number): string {
    return `${TMUX_PREFIX}-${idx}`
  }

  private _buildClaudeCmd(idx: number, sessionId?: string | null): string {
    const port = this._poolConfig.basePort + idx
    const args = [
      this._claudeConfig.bin,
      '--dangerously-load-development-channels', this._claudeConfig.pluginChannel,
      '--dangerously-skip-permissions',
    ]
    if (sessionId) args.push('--resume', sessionId)
    // Use export so env vars are inherited by Claude's child processes (plugin)
    return `export LARK_DISPATCHER_PORT=${port} && export LARK_DAEMON_PORT=${this._poolConfig.daemonApiPort} && ${args.join(' ')}`
  }

  private _killTmux(idx: number): void {
    try {
      spawnSync('tmux', ['kill-session', '-t', this._tmuxName(idx)], { stdio: 'ignore' })
    } catch {}
  }

  private _isTmuxAlive(idx: number): boolean {
    const result = spawnSync('tmux', ['has-session', '-t', this._tmuxName(idx)], { stdio: 'ignore' })
    return result.status === 0
  }

  private async _isHealthy(idx: number): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this._workers[idx].port}/health`)
      return res.ok
    } catch {
      return false
    }
  }

  /** Wait for health check. Returns true if ready, false if timeout/died. */
  private async _waitForReady(idx: number, timeoutMs: number): Promise<boolean> {
    const port = this._workers[idx].port
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      // Check tmux alive
      if (!this._isTmuxAlive(idx)) {
        log.warn(TAG, `Worker[${idx}] tmux session died during startup`)
        return false
      }
      // Check health
      try {
        const res = await fetch(`http://localhost:${port}/health`)
        if (res.ok) return true
      } catch {}
      await this._sleep(1000)
    }
    log.warn(TAG, `Worker[${idx}] :${port} did not become ready in ${timeoutMs / 1000}s`)
    return false
  }

  private _findOldestUsedKey(): string | null {
    let oldest = ''
    let oldestTs = Infinity
    for (const [key, ts] of this._lastUsed) {
      if (this._assignments.has(key) && ts < oldestTs) {
        oldest = key
        oldestTs = ts
      }
    }
    return oldest || null
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }
}
