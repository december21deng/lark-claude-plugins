import { spawnSync } from 'child_process'
import { homedir } from 'os'
import type { Worker, PoolConfig, ClaudeConfig, PendingMessage, ParsedMessage } from './types.js'
import { Mutex } from './utils/mutex.js'
import { log } from './utils/logger.js'

const TAG = 'pool'
const TMUX_PREFIX = 'lark-worker'
const STARTUP_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes per worker
const MAX_RETRIES = 3
const MAX_PENDING_QUEUE = 50

// v5 defaults
const DEFAULT_CLEAR_DELAY_MS = 60_000     // 1 min: IDLE → /clear
const DEFAULT_KILL_DELAY_MS = 300_000     // 5 min: BARE → kill (if > minWorkers)
const DEFAULT_BUSY_TIMEOUT_MS = 600_000   // 10 min: BUSY force idle (crash recovery)

export class WorkerPool {
  private _workers: Worker[] = []
  private _assignments = new Map<string, number>()    // convKey → worker idx
  private _mutexes = new Map<string, Mutex>()         // per-convKey mutex for /clear protection
  private _clearTimers = new Map<string, Timer>()     // convKey → /clear timer
  private _killTimers = new Map<number, Timer>()      // worker idx → kill timer
  private _pendingQueue: PendingMessage[] = []
  private _onDrainPending?: (msg: PendingMessage) => void
  private _busyCheckInterval?: Timer
  private _startingInBackground = false

  private _clearDelayMs: number
  private _killDelayMs: number
  private _busyTimeoutMs: number

  constructor(
    private _poolConfig: PoolConfig,
    private _claudeConfig: ClaudeConfig,
  ) {
    this._clearDelayMs = _poolConfig.clearDelayMs ?? DEFAULT_CLEAR_DELAY_MS
    this._killDelayMs = _poolConfig.killDelayMs ?? DEFAULT_KILL_DELAY_MS
    this._busyTimeoutMs = _poolConfig.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS

    log.info(TAG, `Pool config: min=${_poolConfig.minWorkers} max=${_poolConfig.maxWorkers} ports=${_poolConfig.basePort}+`)
    log.info(TAG, `Timers: clear=${this._clearDelayMs}ms kill=${this._killDelayMs}ms busyTimeout=${this._busyTimeoutMs}ms`)
  }

  /** Pre-trust workspace, kill leftover sessions, start minWorkers in background. */
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

    // Kill leftover tmux sessions (up to maxWorkers)
    for (let i = 0; i < this._poolConfig.maxWorkers; i++) {
      this._killTmux(i)
    }

    // Start minWorkers in background
    this._startingInBackground = true
    this._startInitialWorkers()

    // Start busy timeout checker
    this._busyCheckInterval = setInterval(() => this._checkBusyTimeouts(), 30_000)
  }

  /** Start initial minWorkers sequentially in background. */
  private async _startInitialWorkers(): Promise<void> {
    for (let i = 0; i < this._poolConfig.minWorkers; i++) {
      const worker = this._createWorkerSlot(i)
      this._workers.push(worker)
      const ok = await this._startWorkerWithRetry(i)
      if (ok) {
        const readyCount = this._workers.filter(w => w.ready).length
        log.info(TAG, `Progress: ${readyCount}/${this._poolConfig.minWorkers} workers ready`)
      }
    }
    const readyCount = this._workers.filter(w => w.ready).length
    log.info(TAG, `Initial workers started: ${readyCount}/${this._poolConfig.minWorkers} ready`)
    this._startingInBackground = false
  }

  /** Create a worker slot with default values. */
  private _createWorkerSlot(idx: number): Worker {
    return {
      proc: null,
      port: this._poolConfig.basePort + idx,
      convKey: null,
      startedAt: 0,
      ready: false,
      pid: null,
      busy: false,
      lastActivityAt: 0,
      idx,
    }
  }

  // ── v5: 4-step scheduling ──

  /** Get or assign a worker for a conversation. Returns null if pool exhausted. */
  async getWorker(convKey: string): Promise<Worker | null> {
    // Cancel any pending /clear timer for this convKey (message came in, keep the worker)
    this._cancelClearTimer(convKey)

    // Step 1: convKey already assigned → reuse
    const existingIdx = this._assignments.get(convKey)
    if (existingIdx !== undefined) {
      const w = this._workers[existingIdx]
      if (w.ready && await this._isHealthy(existingIdx)) {
        log.info(TAG, `[Step 1] Reusing worker[${existingIdx}] for ${convKey}`)
        return w
      }
      // Not healthy → restart same worker
      log.warn(TAG, `Worker[${existingIdx}] not healthy, restarting for ${convKey}`)
      this._assignments.delete(convKey)
      await this._restartAndAssign(existingIdx, convKey)
      return this._workers[existingIdx]
    }

    // Step 2: find BARE worker (convKey === null, ready)
    for (const w of this._workers) {
      if (w.convKey === null && w.ready) {
        this._cancelKillTimer(w.idx)
        this._assign(w.idx, convKey)
        log.info(TAG, `[Step 2] Assigned BARE worker[${w.idx}] to ${convKey}`)
        return w
      }
    }

    // Step 3: spawn new worker if under maxWorkers
    if (this._workers.length < this._poolConfig.maxWorkers) {
      const newIdx = this._workers.length
      const worker = this._createWorkerSlot(newIdx)
      this._workers.push(worker)
      log.info(TAG, `[Step 3] Spawning worker[${newIdx}] for ${convKey}`)
      await this._startWorkerWithRetry(newIdx)
      this._assign(newIdx, convKey)
      return this._workers[newIdx]
    }

    // Step 4: pool exhausted
    log.warn(TAG, `[Step 4] Pool exhausted (${this._workers.length}/${this._poolConfig.maxWorkers} workers), ${convKey} must queue`)
    return null
  }

  // ── v5: State transitions ──

  /** Mark a worker as busy. Called by router after forwarding message. */
  markBusy(convKey: string): void {
    const idx = this._assignments.get(convKey)
    if (idx === undefined) return
    this._workers[idx].busy = true
    this._workers[idx].lastActivityAt = Date.now()
    this._cancelClearTimer(convKey)
    log.info(TAG, `markBusy: worker[${idx}] for ${convKey}`)
  }

  /** Mark a worker as idle. Called by daemon on reply/error. */
  markIdle(convKey: string): void {
    const idx = this._assignments.get(convKey)
    if (idx === undefined) return
    this._workers[idx].busy = false
    this._workers[idx].lastActivityAt = Date.now()
    log.info(TAG, `markIdle: worker[${idx}] for ${convKey}`)

    // Start /clear timer
    this._scheduleClear(convKey)

    // Drain pending queue
    this._drainPending()
  }

  /** Update heartbeat timestamp on any tool-call. */
  heartbeat(convKey: string): void {
    const idx = this._assignments.get(convKey)
    if (idx === undefined) return
    this._workers[idx].lastActivityAt = Date.now()
  }

  // ── Pending queue ──

  /** Queue a message when pool is exhausted. Returns queue position. */
  enqueuePending(msg: ParsedMessage, convKey: string): number {
    if (this._pendingQueue.length >= MAX_PENDING_QUEUE) {
      const dropped = this._pendingQueue.shift()
      log.warn(TAG, `Pending queue full, dropped oldest: ${dropped?.convKey}`)
    }
    this._pendingQueue.push({ convKey, msg, queuedAt: Date.now() })
    const pos = this._pendingQueue.length
    log.info(TAG, `Queued message for ${convKey} (position ${pos}/${MAX_PENDING_QUEUE})`)
    return pos
  }

  /** Set callback for draining pending messages. */
  setDrainCallback(fn: (msg: PendingMessage) => void): void {
    this._onDrainPending = fn
  }

  get pendingCount(): number {
    return this._pendingQueue.length
  }

  private _drainPending(): void {
    if (!this._pendingQueue.length || !this._onDrainPending) return
    const pending = this._pendingQueue.shift()
    if (pending) {
      log.info(TAG, `Draining pending: ${pending.convKey} (queued ${((Date.now() - pending.queuedAt) / 1000).toFixed(0)}s ago)`)
      this._onDrainPending(pending)
    }
  }

  // ── v5: /clear mechanism ──

  /** Schedule /clear for an IDLE worker after clearDelayMs. */
  private _scheduleClear(convKey: string): void {
    this._cancelClearTimer(convKey)

    const timer = setTimeout(async () => {
      this._clearTimers.delete(convKey)
      const idx = this._assignments.get(convKey)
      if (idx === undefined) return

      const w = this._workers[idx]
      if (w.busy) return // became busy again, skip

      // Acquire per-convKey mutex to avoid racing with message routing
      const mutex = this._getMutex(convKey)
      await mutex.acquire()
      try {
        // Re-check after acquiring mutex
        if (w.busy || w.convKey !== convKey) return

        log.info(TAG, `/clear: worker[${idx}] (${convKey}) → BARE`)
        this._sendClear(idx)
        this._unassign(convKey)

        // Schedule kill if exceeding minWorkers
        if (this._workers.length > this._poolConfig.minWorkers) {
          this._scheduleKill(idx)
        }
      } finally {
        mutex.release()
      }
    }, this._clearDelayMs)

    this._clearTimers.set(convKey, timer)
  }

  private _cancelClearTimer(convKey: string): void {
    const timer = this._clearTimers.get(convKey)
    if (timer) {
      clearTimeout(timer)
      this._clearTimers.delete(convKey)
    }
  }

  /** Send /clear to a worker via tmux to reset its context. */
  private _sendClear(idx: number): void {
    const name = this._tmuxName(idx)
    try {
      spawnSync('tmux', ['send-keys', '-t', name, '/clear', 'Enter'], { stdio: 'ignore' })
      // Auto-confirm any prompt after /clear
      setTimeout(() => {
        if (this._isTmuxAlive(idx)) {
          spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'ignore' })
        }
      }, 2000)
    } catch (e) {
      log.warn(TAG, `Failed to send /clear to worker[${idx}]: ${e}`)
    }
  }

  // ── v5: kill mechanism (scale down) ──

  /** Schedule kill for a BARE worker after killDelayMs (only if > minWorkers). */
  private _scheduleKill(idx: number): void {
    this._cancelKillTimer(idx)

    const timer = setTimeout(() => {
      this._killTimers.delete(idx)
      const w = this._workers[idx]

      // Re-check: only kill if still BARE and we're above minWorkers
      if (w.convKey !== null || w.busy) return
      if (this._workers.length <= this._poolConfig.minWorkers) return

      log.info(TAG, `Killing excess worker[${idx}] (pool: ${this._workers.length} → ${this._workers.length - 1})`)
      this._killTmux(idx)
      this._removeWorker(idx)
    }, this._killDelayMs)

    this._killTimers.set(idx, timer)
  }

  private _cancelKillTimer(idx: number): void {
    const timer = this._killTimers.get(idx)
    if (timer) {
      clearTimeout(timer)
      this._killTimers.delete(idx)
    }
  }

  /** Remove a worker from the pool (after kill). Re-indexes remaining workers. */
  private _removeWorker(idx: number): void {
    // Update assignments to reflect shifted indices
    this._workers.splice(idx, 1)

    // Re-index all workers after the removed one
    for (let i = idx; i < this._workers.length; i++) {
      this._workers[i].idx = i
      this._workers[i].port = this._poolConfig.basePort + i
    }

    // Rebuild assignments map
    const newAssignments = new Map<string, number>()
    for (const w of this._workers) {
      if (w.convKey) {
        newAssignments.set(w.convKey, w.idx)
      }
    }
    this._assignments = newAssignments
  }

  // ── v5: BUSY timeout (crash recovery) ──

  private _checkBusyTimeouts(): void {
    const now = Date.now()
    for (const w of this._workers) {
      if (w.busy && (now - w.lastActivityAt) > this._busyTimeoutMs) {
        log.warn(TAG, `BUSY timeout: worker[${w.idx}] (${w.convKey}) no heartbeat for ${((now - w.lastActivityAt) / 1000).toFixed(0)}s, forcing idle`)
        if (w.convKey) {
          this.markIdle(w.convKey)
        }
      }
    }
  }

  // ── Assignment helpers ──

  private _assign(workerIdx: number, convKey: string): void {
    this._workers[workerIdx].convKey = convKey
    this._assignments.set(convKey, workerIdx)
  }

  private _unassign(convKey: string): void {
    const idx = this._assignments.get(convKey)
    if (idx !== undefined) {
      this._workers[idx].convKey = null
      this._assignments.delete(convKey)
    }
  }

  private _getMutex(convKey: string): Mutex {
    let m = this._mutexes.get(convKey)
    if (!m) {
      m = new Mutex()
      this._mutexes.set(convKey, m)
    }
    return m
  }

  // ── Restart and assign (for unhealthy workers) ──

  private async _restartAndAssign(idx: number, convKey: string): Promise<void> {
    await this._startWorkerWithRetry(idx)
    this._assign(idx, convKey)
  }

  // ── Graceful shutdown ──

  async shutdown(): Promise<void> {
    log.info(TAG, 'Shutting down pool...')

    // Clear all timers
    if (this._busyCheckInterval) clearInterval(this._busyCheckInterval)
    for (const timer of this._clearTimers.values()) clearTimeout(timer)
    for (const timer of this._killTimers.values()) clearTimeout(timer)
    this._clearTimers.clear()
    this._killTimers.clear()

    // Kill all workers
    for (let i = 0; i < this._workers.length; i++) {
      this._killTmux(i)
    }
    log.info(TAG, 'Pool shut down')
  }

  /** Get pool status. */
  status(): string {
    const readyCount = this._workers.filter(w => w.ready).length
    const busyCount = this._workers.filter(w => w.busy).length
    const bareCount = this._workers.filter(w => w.convKey === null).length
    const now = Date.now()

    const lines: string[] = [
      `Workers: ${this._workers.length} total (${readyCount} ready, ${busyCount} busy, ${bareCount} bare)${this._startingInBackground ? ' [starting...]' : ''}`,
      `Pool: min=${this._poolConfig.minWorkers} max=${this._poolConfig.maxWorkers}`,
    ]

    for (const w of this._workers) {
      const alive = this._isTmuxAlive(w.idx) ? '●' : '○'
      const status = w.ready ? '' : ' [starting]'
      if (w.convKey) {
        const idle = Math.round((now - w.lastActivityAt) / 1000)
        const state = w.busy ? 'BUSY' : 'IDLE'
        lines.push(`  ${alive} [${w.idx}] :${w.port} → ${w.convKey} [${state}] (${idle}s ago)${status}`)
      } else {
        lines.push(`  ${alive} [${w.idx}] :${w.port} → (bare)${status}`)
      }
    }

    if (this._pendingQueue.length > 0) {
      lines.push(`Pending queue: ${this._pendingQueue.length} messages`)
    }

    return lines.join('\n')
  }

  // ── tmux operations ──

  private _tmuxName(idx: number): string {
    return `${TMUX_PREFIX}-${idx}`
  }

  /** Build Claude CLI command. v5: always bare start, no session flags. */
  private _buildClaudeCmd(idx: number): string {
    const port = this._poolConfig.basePort + idx
    const args = [
      this._claudeConfig.bin,
      '--dangerously-load-development-channels', this._claudeConfig.pluginChannel,
      '--dangerously-skip-permissions',
      '--disallowed-tools', 'mcp__lark-mcp__im.message.create,mcp__lark-mcp__im.message.reply,mcp__lark-mcp__im.v1.message.create,mcp__lark-mcp__im.v1.message.reply',
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
      '如果消息中包含 <history> 标签，那是该话题的历史聊天记录，用于帮助你理解上下文。你只需要回复最新的消息（<history> 标签外的内容），不要回复历史消息。',
      '禁止使用 lark-mcp 的任何工具发送或回复消息（如 im.message.create、im.message.reply），所有飞书消息必须且只能通过 reply 工具发送。lark-mcp 的其他工具（文档、表格、日历等）可以正常使用。',
    ].join(' ')
    const parts = [safetyRules]
    if (this._claudeConfig.systemPrompt) parts.push(this._claudeConfig.systemPrompt)
    args.push('--append-system-prompt', JSON.stringify(parts.join('\n')))

    // v5: no --resume or --session-id, always bare start
    return `export LARK_DISPATCHER_PORT=${port} && export LARK_DAEMON_PORT=${this._poolConfig.daemonApiPort} && ${args.join(' ')}`
  }

  /** Start a worker with retries. */
  private async _startWorkerWithRetry(idx: number): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      log.info(TAG, `Starting worker[${idx}] (attempt ${attempt}/${MAX_RETRIES})`)

      this._killTmux(idx)
      await this._sleep(500)

      const ok = await this._startWorker(idx)
      if (ok) return true

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
  private async _startWorker(idx: number): Promise<boolean> {
    const name = this._tmuxName(idx)
    const cmd = this._buildClaudeCmd(idx)

    spawnSync('tmux', [
      'new-session', '-d', '-s', name,
      '-x', '120', '-y', '30',
      cmd,
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

    // Wait for health check
    const ok = await this._waitForReady(idx, STARTUP_TIMEOUT_MS)

    if (ok) {
      this._workers[idx].ready = true
      this._workers[idx].startedAt = Date.now()
      this._workers[idx].lastActivityAt = Date.now()
      log.info(TAG, `Worker[${idx}] ready on :${this._workers[idx].port}`)
    }

    return ok
  }

  private _diagnoseWorker(idx: number): string {
    const name = this._tmuxName(idx)
    if (!this._isTmuxAlive(idx)) {
      return 'tmux session died (Claude CLI crashed or exited)'
    }
    try {
      const result = spawnSync('tmux', ['capture-pane', '-t', name, '-p'], {
        encoding: 'utf-8',
        timeout: 5000,
      })
      const output = (result.stdout ?? '').toString()
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .trim()
        .split('\n')
        .slice(-10)
        .join(' | ')
      return `tmux alive but not ready. Terminal: ${output || '(empty)'}`
    } catch {
      return 'tmux alive but could not capture terminal output'
    }
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
      if (!res.ok) return false
      const data = await res.json() as { ready?: boolean }
      return data.ready === true
    } catch {
      return false
    }
  }

  private async _waitForReady(idx: number, timeoutMs: number): Promise<boolean> {
    const port = this._workers[idx].port
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (!this._isTmuxAlive(idx)) {
        log.warn(TAG, `Worker[${idx}] tmux session died during startup`)
        return false
      }
      try {
        const res = await fetch(`http://localhost:${port}/health`)
        if (res.ok) {
          const data = await res.json() as { ready?: boolean }
          if (data.ready === true) return true
        }
      } catch {}
      await this._sleep(1000)
    }
    log.warn(TAG, `Worker[${idx}] :${port} did not become ready in ${timeoutMs / 1000}s`)
    return false
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }
}
