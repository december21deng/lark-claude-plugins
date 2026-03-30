import { execSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
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

  /** Start a worker with retries. */
  private async _startWorkerWithRetry(idx: number, opts?: { resumeSessionId?: string; newSessionId?: string }): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log.info(TAG, `Starting worker[${idx}] (attempt ${attempt}/${MAX_RETRIES})`)

      this._killTmux(idx)
      await this._sleep(500)

      const ok = await this._startWorker(idx, opts)
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
  private async _startWorker(idx: number, opts?: { resumeSessionId?: string; newSessionId?: string }): Promise<boolean> {
    const name = this._tmuxName(idx)
    const cmd = this._buildClaudeCmd(idx, opts)

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
        log.info(TAG, `Reusing worker[${existingIdx}] for ${convKey} (session=${w.sessionId})`)
        return w
      }
      // Not healthy — restart with resume
      log.warn(TAG, `Worker[${existingIdx}] not healthy, restarting for ${convKey}`)
      this._assignments.delete(convKey)
      const savedSession = w.sessionId ?? this._sessions.get(convKey)
      await this._assignAndStart(existingIdx, convKey, savedSession)
      return this._workers[existingIdx]
    }

    // 2. Find idle ready worker → restart with session for this convKey
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      if (w.convKey !== null) continue
      if (!w.ready || !await this._isHealthy(i)) continue
      const savedSession = this._sessions.get(convKey)
      await this._assignAndStart(i, convKey, savedSession)
      log.info(TAG, `Assigned worker[${i}] :${this._workers[i].port} to ${convKey} (session=${this._workers[i].sessionId})`)
      return this._workers[i]
    }

    // 3. Find idle NOT ready worker → start it
    for (let i = 0; i < this._workers.length; i++) {
      const w = this._workers[i]
      if (w.convKey !== null) continue
      log.info(TAG, `Worker[${i}] not ready, starting on demand for ${convKey}`)
      const savedSession = this._sessions.get(convKey)
      await this._assignAndStart(i, convKey, savedSession)
      return this._workers[i]
    }

    // 4. Pool full → evict oldest, restart with new session
    const victimKey = this._findOldestUsedKey()
    if (victimKey) {
      const victimIdx = this._assignments.get(victimKey)!
      log.info(TAG, `Evicting worker[${victimIdx}] (${victimKey}) for ${convKey}`)

      // Save victim's session before evicting
      const victimWorker = this._workers[victimIdx]
      if (victimWorker.sessionId) {
        this._sessions.set(victimKey, victimWorker.sessionId)
      }
      this._assignments.delete(victimKey)

      const savedSession = this._sessions.get(convKey)
      await this._assignAndStart(victimIdx, convKey, savedSession)
      return this._workers[victimIdx]
    }

    throw new Error('No workers available')
  }

  /** Restart a worker with session management and assign to convKey. */
  private async _assignAndStart(idx: number, convKey: string, savedSessionId?: string): Promise<void> {
    let opts: { resumeSessionId?: string; newSessionId?: string }

    if (savedSessionId) {
      // Resume existing session
      opts = { resumeSessionId: savedSessionId }
      log.info(TAG, `Worker[${idx}]: resuming session ${savedSessionId} for ${convKey}`)
    } else {
      // New conversation — generate UUID so we can track it
      const newId = randomUUID()
      opts = { newSessionId: newId }
      log.info(TAG, `Worker[${idx}]: new session ${newId} for ${convKey}`)
    }

    await this._startWorkerWithRetry(idx, opts)

    const w = this._workers[idx]
    w.convKey = convKey
    w.sessionId = savedSessionId ?? opts.newSessionId ?? null
    this._assignments.set(convKey, idx)
    this._lastUsed.set(convKey, Date.now())

    // Persist session immediately
    if (w.sessionId) {
      this._sessions.set(convKey, w.sessionId)
    }
  }

  /** Terminate a specific conversation's worker and delete its session. */
  async clearConversation(convKey: string): Promise<void> {
    const idx = this._assignments.get(convKey)
    if (idx !== undefined) {
      this._assignments.delete(convKey)
      this._workers[idx].convKey = null
      this._workers[idx].sessionId = null
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

  /**
   * Build Claude CLI command.
   * - resumeSessionId: existing session to resume (--resume)
   * - newSessionId: fresh session with known UUID (--session-id)
   * - neither: bare start (idle worker, no session yet)
   */
  private _buildClaudeCmd(idx: number, opts?: { resumeSessionId?: string; newSessionId?: string }): string {
    const port = this._poolConfig.basePort + idx
    const args = [
      this._claudeConfig.bin,
      '--dangerously-load-development-channels', this._claudeConfig.pluginChannel,
      '--dangerously-skip-permissions',
    ]

    if (this._claudeConfig.model) {
      args.push('--model', this._claudeConfig.model)
    }

    // System prompt: safety rules for unattended workers + user-defined prompt
    const safetyRules = [
      '你运行在无人值守的飞书 bot worker 中，终端没有人可以回应交互确认。',
      '禁止执行任何需要终端交互确认的操作，包括但不限于：修改 ~/.mcp.json、修改 ~/.claude/ 配置、安装全局包。',
      '如果用户要求这类操作，告诉他们在自己的终端里执行。',
      '当用户要求管理 bot 的群权限或管理员时，必须使用 manage_access tool，不要自己判断是否允许——直接调用，后端会检查权限和聊天类型。如果 manage_access 返回错误，必须将错误消息原样转发给用户，不要自己重新措辞或猜测原因。绝对不要使用 /lark-customized:access skill 来管理权限——那个 skill 只管理消息通道的 access.json，不是 bot 的群权限和管理员。manage_access 支持 add_group/remove_group/list_groups/add_admin/remove_admin/list_admins。消息 meta 中的 chat_type 字段标识当前是私聊(private)还是群聊(group)。',
      '需要浏览器时，必须使用 Chrome MCP（chrome-devtools 或 Claude_in_Chrome），禁止使用无头浏览器（headless）。',
      '禁止手动 react 状态 emoji（👀、✅、🤔等）到用户消息上，系统已自动管理状态 emoji。只有表达语义时才用 react tool。',
      '优先使用已安装的 skill（/skill-name）来完成任务，不要自己从零实现 skill 已覆盖的功能。',
      '不确定飞书 API 是否支持某功能时，先用 Context7 查文档或使用相关 skill，禁止凭猜测回答"不支持"或"做不到"。',
      '所有飞书回复必须使用 /feishu-card skill 生成 v2 格式的交互卡片 JSON，禁止发送纯文本或 markdown。即使是简短回复，也必须包含 header（带颜色）和 body.elements。卡片 JSON 作为 reply 工具的 text 参数传入即可。',
    ].join(' ')
    const parts = [safetyRules]
    if (this._claudeConfig.systemPrompt) parts.push(this._claudeConfig.systemPrompt)
    args.push('--append-system-prompt', JSON.stringify(parts.join('\n')))

    if (opts?.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId)
    } else if (opts?.newSessionId) {
      args.push('--session-id', opts.newSessionId)
    }

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
