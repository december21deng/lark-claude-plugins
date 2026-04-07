import { describe, test, expect, beforeEach, jest } from 'bun:test'

/**
 * Tests for v5 dynamic worker pool scheduling.
 *
 * Replicates core scheduling logic as pure functions to test without
 * tmux / Claude CLI dependencies.
 */

// ── Types (matches pool.ts / types.ts v5) ──

interface WorkerState {
  idx: number
  convKey: string | null
  busy: boolean
  lastActivityAt: number
  ready: boolean
}

interface PendingMessage {
  convKey: string
  text: string
  queuedAt: number
}

// ── Worker state classification (v5: 3 states) ──

type WorkerClass = 'BARE' | 'BUSY' | 'IDLE'

function classifyWorker(w: WorkerState): WorkerClass {
  if (w.convKey === null) return 'BARE'
  if (w.busy) return 'BUSY'
  return 'IDLE'
}

// ── getWorker scheduling logic (v5: 4-step) ──

interface ScheduleResult {
  type: 'reuse' | 'bare' | 'spawn' | 'queue'
  workerIdx?: number
}

function schedule(
  workers: WorkerState[],
  assignments: Map<string, number>,
  convKey: string,
  maxWorkers: number,
): ScheduleResult {
  // Step 1: convKey already assigned → reuse
  const existingIdx = assignments.get(convKey)
  if (existingIdx !== undefined) {
    const w = workers[existingIdx]
    if (w.ready) return { type: 'reuse', workerIdx: existingIdx }
  }

  // Step 2: find BARE worker
  for (const w of workers) {
    if (w.convKey === null && w.ready) {
      return { type: 'bare', workerIdx: w.idx }
    }
  }

  // Step 3: can spawn?
  if (workers.length < maxWorkers) {
    return { type: 'spawn', workerIdx: workers.length } // next index
  }

  // Step 4: queue
  return { type: 'queue' }
}

// ── markBusy / markIdle ──

function markBusy(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].busy = true
  workers[idx].lastActivityAt = Date.now()
}

function markIdle(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].busy = false
  workers[idx].lastActivityAt = Date.now()
}

// ── /clear: unbind convKey, worker becomes BARE ──

function clearWorker(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].convKey = null
  workers[idx].busy = false
  assignments.delete(convKey)
}

// ── assign: bind convKey to a BARE worker ──

function assignWorker(workers: WorkerState[], assignments: Map<string, number>, workerIdx: number, convKey: string): void {
  workers[workerIdx].convKey = convKey
  workers[workerIdx].busy = false
  assignments.set(convKey, workerIdx)
}

// ── heartbeat ──

function heartbeat(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].lastActivityAt = Date.now()
}

// ── busy timeout check ──

function findTimedOutWorkers(workers: WorkerState[], busyTimeoutMs: number, now: number): number[] {
  const timedOut: number[] = []
  for (const w of workers) {
    if (w.busy && (now - w.lastActivityAt) > busyTimeoutMs) {
      timedOut.push(w.idx)
    }
  }
  return timedOut
}

// ── workers eligible for /clear (IDLE > clearDelayMs) ──

function findClearableWorkers(workers: WorkerState[], clearDelayMs: number, now: number): number[] {
  return workers
    .filter(w => w.convKey !== null && !w.busy && (now - w.lastActivityAt) > clearDelayMs)
    .map(w => w.idx)
}

// ── workers eligible for kill (BARE > killDelayMs, exceeding minWorkers) ──

function findKillableWorkers(
  workers: WorkerState[],
  killDelayMs: number,
  minWorkers: number,
  now: number,
): number[] {
  // Only kill BARE workers that have been idle long enough
  const bareWorkers = workers
    .filter(w => w.convKey === null && !w.busy && w.ready && (now - w.lastActivityAt) > killDelayMs)
    .map(w => w.idx)

  // Only kill down to minWorkers
  const excess = workers.length - minWorkers
  if (excess <= 0) return []
  return bareWorkers.slice(0, excess)
}

// ── Pending queue ──

const MAX_PENDING = 50

function enqueuePending(queue: PendingMessage[], convKey: string, text: string): number {
  if (queue.length >= MAX_PENDING) {
    queue.shift()
  }
  queue.push({ convKey, text, queuedAt: Date.now() })
  return queue.length
}

function dequeuePending(queue: PendingMessage[]): PendingMessage | undefined {
  return queue.shift()
}

// ══════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════

describe('v5: worker state classification', () => {
  test('unassigned worker → BARE', () => {
    const w: WorkerState = { idx: 0, convKey: null, busy: false, lastActivityAt: 0, ready: true }
    expect(classifyWorker(w)).toBe('BARE')
  })

  test('assigned busy worker → BUSY', () => {
    const w: WorkerState = { idx: 0, convKey: 'conv_1', busy: true, lastActivityAt: Date.now(), ready: true }
    expect(classifyWorker(w)).toBe('BUSY')
  })

  test('assigned idle worker → IDLE', () => {
    const w: WorkerState = { idx: 0, convKey: 'conv_1', busy: false, lastActivityAt: Date.now(), ready: true }
    expect(classifyWorker(w)).toBe('IDLE')
  })

  test('no STALE or RECYCLABLE states in v5', () => {
    // Even very old idle workers are just IDLE — /clear handles them
    const w: WorkerState = { idx: 0, convKey: 'conv_1', busy: false, lastActivityAt: 0, ready: true }
    expect(classifyWorker(w)).toBe('IDLE')
  })
})

describe('v5: 4-step scheduling', () => {
  let workers: WorkerState[]
  let assignments: Map<string, number>

  beforeEach(() => {
    workers = [
      { idx: 0, convKey: null, busy: false, lastActivityAt: 0, ready: true },
      { idx: 1, convKey: null, busy: false, lastActivityAt: 0, ready: true },
      { idx: 2, convKey: null, busy: false, lastActivityAt: 0, ready: true },
    ]
    assignments = new Map()
  })

  test('Step 1: reuse existing worker for same convKey', () => {
    workers[1].convKey = 'conv_A'
    assignments.set('conv_A', 1)

    const result = schedule(workers, assignments, 'conv_A', 10)
    expect(result.type).toBe('reuse')
    expect(result.workerIdx).toBe(1)
  })

  test('Step 1: reuse even if worker is BUSY (Mutex serializes)', () => {
    workers[1].convKey = 'conv_A'
    workers[1].busy = true
    assignments.set('conv_A', 1)

    const result = schedule(workers, assignments, 'conv_A', 10)
    expect(result.type).toBe('reuse')
    expect(result.workerIdx).toBe(1)
  })

  test('Step 2: assign BARE worker', () => {
    workers[0].convKey = 'conv_A'
    assignments.set('conv_A', 0)
    // workers[1] and [2] are BARE

    const result = schedule(workers, assignments, 'conv_B', 10)
    expect(result.type).toBe('bare')
    expect(result.workerIdx).toBe(1)
  })

  test('Step 2: picks first BARE worker', () => {
    // All BARE
    const result = schedule(workers, assignments, 'conv_A', 10)
    expect(result.type).toBe('bare')
    expect(result.workerIdx).toBe(0)
  })

  test('Step 3: spawn when no BARE and under maxWorkers', () => {
    // All workers assigned
    for (let i = 0; i < workers.length; i++) {
      workers[i].convKey = `conv_${i}`
      workers[i].busy = true
      assignments.set(`conv_${i}`, i)
    }

    const result = schedule(workers, assignments, 'conv_new', 10) // max 10, currently 3
    expect(result.type).toBe('spawn')
    expect(result.workerIdx).toBe(3)
  })

  test('Step 4: queue when at maxWorkers and no BARE', () => {
    // All workers assigned, maxWorkers = 3 (equal to current)
    for (let i = 0; i < workers.length; i++) {
      workers[i].convKey = `conv_${i}`
      workers[i].busy = true
      assignments.set(`conv_${i}`, i)
    }

    const result = schedule(workers, assignments, 'conv_new', 3)
    expect(result.type).toBe('queue')
  })

  test('Step 2 skips non-ready BARE workers', () => {
    workers[0].ready = false // not ready
    workers[1].convKey = 'conv_A'
    assignments.set('conv_A', 1)
    // workers[2] is BARE and ready

    const result = schedule(workers, assignments, 'conv_B', 10)
    expect(result.type).toBe('bare')
    expect(result.workerIdx).toBe(2)
  })

  test('IDLE workers are NOT grabbed by different convKey (no eviction in v5)', () => {
    // workers[0] is IDLE (assigned, not busy)
    workers[0].convKey = 'conv_A'
    assignments.set('conv_A', 0)
    // workers[1] and [2] are BARE

    const result = schedule(workers, assignments, 'conv_B', 10)
    // Should pick BARE worker, not evict IDLE
    expect(result.type).toBe('bare')
    expect(result.workerIdx).toBe(1) // first BARE
  })

  test('all IDLE + at maxWorkers → queue (no eviction)', () => {
    for (let i = 0; i < workers.length; i++) {
      workers[i].convKey = `conv_${i}`
      workers[i].busy = false // IDLE, not BUSY
      assignments.set(`conv_${i}`, i)
    }

    // maxWorkers = 3, all IDLE — v5 does NOT evict IDLE, it queues
    // (because /clear timer will make them BARE soon)
    const result = schedule(workers, assignments, 'conv_new', 3)
    expect(result.type).toBe('queue')
  })
})

describe('v5: markBusy / markIdle', () => {
  let workers: WorkerState[]
  let assignments: Map<string, number>

  beforeEach(() => {
    workers = [{ idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: 0, ready: true }]
    assignments = new Map([['conv_A', 0]])
  })

  test('markBusy sets busy=true', () => {
    markBusy(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(true)
  })

  test('markBusy updates lastActivityAt', () => {
    const before = Date.now()
    markBusy(workers, assignments, 'conv_A')
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  test('markIdle sets busy=false', () => {
    workers[0].busy = true
    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(false)
  })

  test('markIdle updates lastActivityAt', () => {
    workers[0].busy = true
    const before = Date.now()
    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  test('markBusy on unknown convKey is no-op', () => {
    markBusy(workers, assignments, 'conv_UNKNOWN')
    expect(workers[0].busy).toBe(false)
  })

  test('markIdle on unknown convKey is no-op', () => {
    workers[0].busy = true
    markIdle(workers, assignments, 'conv_UNKNOWN')
    expect(workers[0].busy).toBe(true)
  })
})

describe('v5: /clear (worker unbinding)', () => {
  test('clearWorker unbinds convKey → worker becomes BARE', () => {
    const workers: WorkerState[] = [{ idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: Date.now(), ready: true }]
    const assignments = new Map([['conv_A', 0]])

    clearWorker(workers, assignments, 'conv_A')

    expect(workers[0].convKey).toBeNull()
    expect(workers[0].busy).toBe(false)
    expect(assignments.has('conv_A')).toBe(false)
    expect(classifyWorker(workers[0])).toBe('BARE')
  })

  test('clearWorker on unknown convKey is no-op', () => {
    const workers: WorkerState[] = [{ idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: Date.now(), ready: true }]
    const assignments = new Map([['conv_A', 0]])

    clearWorker(workers, assignments, 'conv_UNKNOWN')

    expect(workers[0].convKey).toBe('conv_A')
    expect(assignments.has('conv_A')).toBe(true)
  })

  test('cleared worker can be reassigned to new convKey', () => {
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: Date.now(), ready: true },
    ]
    const assignments = new Map([['conv_A', 0]])

    clearWorker(workers, assignments, 'conv_A')
    assignWorker(workers, assignments, 0, 'conv_B')

    expect(workers[0].convKey).toBe('conv_B')
    expect(assignments.get('conv_B')).toBe(0)
    expect(assignments.has('conv_A')).toBe(false)
  })
})

describe('v5: heartbeat', () => {
  test('heartbeat updates lastActivityAt', () => {
    const workers: WorkerState[] = [{ idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: 0, ready: true }]
    const assignments = new Map([['conv_A', 0]])

    const before = Date.now()
    heartbeat(workers, assignments, 'conv_A')
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  test('heartbeat does not change busy state', () => {
    const workers: WorkerState[] = [{ idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: 0, ready: true }]
    const assignments = new Map([['conv_A', 0]])

    heartbeat(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(true)
  })

  test('heartbeat on unknown convKey is no-op', () => {
    const workers: WorkerState[] = [{ idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: 0, ready: true }]
    const assignments = new Map([['conv_A', 0]])

    heartbeat(workers, assignments, 'conv_UNKNOWN')
    expect(workers[0].lastActivityAt).toBe(0)
  })
})

describe('v5: BUSY timeout (crash recovery)', () => {
  const BUSY_TIMEOUT = 600_000 // 10 min

  test('finds workers that exceeded busy timeout', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: now - BUSY_TIMEOUT - 1000, ready: true },
      { idx: 1, convKey: 'conv_B', busy: true, lastActivityAt: now - 1000, ready: true }, // recent
      { idx: 2, convKey: null, busy: false, lastActivityAt: 0, ready: true }, // BARE
    ]

    const timedOut = findTimedOutWorkers(workers, BUSY_TIMEOUT, now)
    expect(timedOut).toEqual([0])
  })

  test('no timeout if heartbeat is recent', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: now - 1000, ready: true },
    ]

    const timedOut = findTimedOutWorkers(workers, BUSY_TIMEOUT, now)
    expect(timedOut).toEqual([])
  })

  test('IDLE workers are not affected by busy timeout', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: now - BUSY_TIMEOUT - 1000, ready: true },
    ]

    const timedOut = findTimedOutWorkers(workers, BUSY_TIMEOUT, now)
    expect(timedOut).toEqual([])
  })

  test('multiple timed-out workers found', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: now - BUSY_TIMEOUT - 5000, ready: true },
      { idx: 1, convKey: 'conv_B', busy: true, lastActivityAt: now - BUSY_TIMEOUT - 1000, ready: true },
    ]

    const timedOut = findTimedOutWorkers(workers, BUSY_TIMEOUT, now)
    expect(timedOut).toEqual([0, 1])
  })
})

describe('v5: /clear eligibility (IDLE → BARE)', () => {
  const CLEAR_DELAY = 60_000 // 1 min

  test('IDLE worker past clearDelay is clearable', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: now - CLEAR_DELAY - 1000, ready: true },
    ]

    expect(findClearableWorkers(workers, CLEAR_DELAY, now)).toEqual([0])
  })

  test('recently IDLE worker is NOT clearable', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: false, lastActivityAt: now - 1000, ready: true },
    ]

    expect(findClearableWorkers(workers, CLEAR_DELAY, now)).toEqual([])
  })

  test('BUSY worker is NOT clearable', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: 'conv_A', busy: true, lastActivityAt: now - CLEAR_DELAY - 1000, ready: true },
    ]

    expect(findClearableWorkers(workers, CLEAR_DELAY, now)).toEqual([])
  })

  test('BARE worker is NOT clearable (already cleared)', () => {
    const now = Date.now()
    const workers: WorkerState[] = [
      { idx: 0, convKey: null, busy: false, lastActivityAt: now - CLEAR_DELAY - 1000, ready: true },
    ]

    expect(findClearableWorkers(workers, CLEAR_DELAY, now)).toEqual([])
  })
})

describe('v5: kill eligibility (BARE → kill when > minWorkers)', () => {
  const KILL_DELAY = 300_000 // 5 min
  const MIN_WORKERS = 10

  test('excess BARE worker past killDelay is killable', () => {
    const now = Date.now()
    // 12 workers, 12 > minWorkers(10)
    const workers: WorkerState[] = Array.from({ length: 12 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: now - KILL_DELAY - 1000,
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    expect(killable.length).toBe(2) // only kill down to minWorkers
  })

  test('at minWorkers → nothing killable', () => {
    const now = Date.now()
    const workers: WorkerState[] = Array.from({ length: 10 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: now - KILL_DELAY - 1000,
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    expect(killable.length).toBe(0)
  })

  test('below minWorkers → nothing killable', () => {
    const now = Date.now()
    const workers: WorkerState[] = Array.from({ length: 5 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: now - KILL_DELAY - 1000,
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    expect(killable.length).toBe(0)
  })

  test('recently BARE workers are NOT killable', () => {
    const now = Date.now()
    const workers: WorkerState[] = Array.from({ length: 15 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: now - 1000, // very recent
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    expect(killable.length).toBe(0)
  })

  test('assigned workers are NOT killable', () => {
    const now = Date.now()
    const workers: WorkerState[] = Array.from({ length: 15 }, (_, i) => ({
      idx: i,
      convKey: `conv_${i}`, // all assigned
      busy: false,
      lastActivityAt: now - KILL_DELAY - 1000,
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    expect(killable.length).toBe(0)
  })

  test('mix of BARE and assigned: only excess BARE killed', () => {
    const now = Date.now()
    const workers: WorkerState[] = Array.from({ length: 15 }, (_, i) => ({
      idx: i,
      convKey: i < 8 ? `conv_${i}` : null, // 8 assigned, 7 BARE
      busy: false,
      lastActivityAt: now - KILL_DELAY - 1000,
      ready: true,
    }))

    const killable = findKillableWorkers(workers, KILL_DELAY, MIN_WORKERS, now)
    // excess = 15 - 10 = 5, but only 7 BARE workers, so kill min(7, 5) = 5
    expect(killable.length).toBe(5)
    // Should be the BARE ones (idx 8-12)
    expect(killable).toEqual([8, 9, 10, 11, 12])
  })
})

describe('v5: pending queue', () => {
  test('enqueue returns position', () => {
    const queue: PendingMessage[] = []
    expect(enqueuePending(queue, 'conv_A', 'hello')).toBe(1)
    expect(enqueuePending(queue, 'conv_B', 'world')).toBe(2)
  })

  test('dequeue returns FIFO order', () => {
    const queue: PendingMessage[] = []
    enqueuePending(queue, 'conv_A', 'first')
    enqueuePending(queue, 'conv_B', 'second')

    expect(dequeuePending(queue)?.convKey).toBe('conv_A')
    expect(dequeuePending(queue)?.convKey).toBe('conv_B')
    expect(dequeuePending(queue)).toBeUndefined()
  })

  test('drops oldest when at max capacity', () => {
    const queue: PendingMessage[] = []
    for (let i = 0; i < MAX_PENDING; i++) {
      enqueuePending(queue, `conv_${i}`, `msg_${i}`)
    }
    expect(queue.length).toBe(MAX_PENDING)

    enqueuePending(queue, 'conv_overflow', 'overflow')
    expect(queue.length).toBe(MAX_PENDING)
    expect(queue[0].convKey).toBe('conv_1') // conv_0 dropped
    expect(queue[queue.length - 1].convKey).toBe('conv_overflow')
  })
})

describe('v5: full lifecycle scenarios', () => {
  let workers: WorkerState[]
  let assignments: Map<string, number>

  beforeEach(() => {
    // Start with 3 BARE workers (simulating minWorkers=3)
    workers = Array.from({ length: 3 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: 0,
      ready: true,
    }))
    assignments = new Map()
  })

  test('normal lifecycle: BARE → BUSY → IDLE → /clear → BARE', () => {
    // 1. New message comes in
    const r = schedule(workers, assignments, 'conv_A', 10)
    expect(r.type).toBe('bare')
    assignWorker(workers, assignments, r.workerIdx!, 'conv_A')
    expect(classifyWorker(workers[0])).toBe('IDLE') // assigned but not yet busy

    // 2. Message forwarded → BUSY
    markBusy(workers, assignments, 'conv_A')
    expect(classifyWorker(workers[0])).toBe('BUSY')

    // 3. Reply received → IDLE
    markIdle(workers, assignments, 'conv_A')
    expect(classifyWorker(workers[0])).toBe('IDLE')

    // 4. /clear after 1 min → BARE
    clearWorker(workers, assignments, 'conv_A')
    expect(classifyWorker(workers[0])).toBe('BARE')
    expect(assignments.size).toBe(0)
  })

  test('same convKey reuses worker (no wait)', () => {
    // Assign worker to conv_A
    assignWorker(workers, assignments, 0, 'conv_A')
    markBusy(workers, assignments, 'conv_A')
    markIdle(workers, assignments, 'conv_A')

    // Same convKey comes again → reuse
    const r = schedule(workers, assignments, 'conv_A', 10)
    expect(r.type).toBe('reuse')
    expect(r.workerIdx).toBe(0)
  })

  test('same convKey while worker BUSY → still reuse (Mutex serializes)', () => {
    assignWorker(workers, assignments, 0, 'conv_A')
    markBusy(workers, assignments, 'conv_A')
    // Worker is BUSY, but same convKey → reuse

    const r = schedule(workers, assignments, 'conv_A', 10)
    expect(r.type).toBe('reuse')
    expect(r.workerIdx).toBe(0)
  })

  test('different convKey gets different BARE worker', () => {
    assignWorker(workers, assignments, 0, 'conv_A')

    const r = schedule(workers, assignments, 'conv_B', 10)
    expect(r.type).toBe('bare')
    expect(r.workerIdx).toBe(1) // different worker
  })

  test('pool scales up when all workers assigned', () => {
    // Assign all 3 workers
    for (let i = 0; i < 3; i++) {
      assignWorker(workers, assignments, i, `conv_${i}`)
      markBusy(workers, assignments, `conv_${i}`)
    }

    // New convKey → spawn (maxWorkers=10)
    const r = schedule(workers, assignments, 'conv_new', 10)
    expect(r.type).toBe('spawn')
    expect(r.workerIdx).toBe(3)
  })

  test('/clear frees worker for next conversation', () => {
    assignWorker(workers, assignments, 0, 'conv_A')
    markBusy(workers, assignments, 'conv_A')
    markIdle(workers, assignments, 'conv_A')
    clearWorker(workers, assignments, 'conv_A') // → BARE

    // Now conv_B can use worker[0]
    const r = schedule(workers, assignments, 'conv_B', 10)
    expect(r.type).toBe('bare')
    expect(r.workerIdx).toBe(0)
  })

  test('BUSY timeout recovery: stuck worker forced idle then cleared', () => {
    const now = Date.now()
    assignWorker(workers, assignments, 0, 'conv_A')
    workers[0].busy = true
    workers[0].lastActivityAt = now - 600_001 // 10 min + 1ms

    // Detect timed out
    const timedOut = findTimedOutWorkers(workers, 600_000, now)
    expect(timedOut).toEqual([0])

    // Force idle
    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(false)

    // Then /clear will happen via timer
    clearWorker(workers, assignments, 'conv_A')
    expect(classifyWorker(workers[0])).toBe('BARE')
  })

  test('new message for IDLE convKey cancels /clear (reuse)', () => {
    assignWorker(workers, assignments, 0, 'conv_A')
    markBusy(workers, assignments, 'conv_A')
    markIdle(workers, assignments, 'conv_A')
    // Worker is IDLE, /clear timer started...

    // Before 1 min passes, same convKey sends new message
    const r = schedule(workers, assignments, 'conv_A', 10)
    expect(r.type).toBe('reuse')
    expect(r.workerIdx).toBe(0)
    // /clear timer should be cancelled (tested in integration)
  })

  test('concurrent conversations use separate workers', () => {
    const r1 = schedule(workers, assignments, 'conv_A', 10)
    assignWorker(workers, assignments, r1.workerIdx!, 'conv_A')
    markBusy(workers, assignments, 'conv_A')

    const r2 = schedule(workers, assignments, 'conv_B', 10)
    assignWorker(workers, assignments, r2.workerIdx!, 'conv_B')
    markBusy(workers, assignments, 'conv_B')

    expect(r1.workerIdx).not.toBe(r2.workerIdx)
    expect(workers[r1.workerIdx!].convKey).toBe('conv_A')
    expect(workers[r2.workerIdx!].convKey).toBe('conv_B')
  })
})

describe('v5: dynamic scaling scenarios', () => {
  test('spawn → work → /clear → kill (scale down)', () => {
    const now = Date.now()

    // Start with 10 workers (minWorkers)
    const workers: WorkerState[] = Array.from({ length: 10 }, (_, i) => ({
      idx: i,
      convKey: null,
      busy: false,
      lastActivityAt: now,
      ready: true,
    }))
    const assignments = new Map<string, number>()

    // All 10 get assigned
    for (let i = 0; i < 10; i++) {
      assignWorker(workers, assignments, i, `conv_${i}`)
      markBusy(workers, assignments, `conv_${i}`)
    }

    // New request → spawn worker[10]
    const r = schedule(workers, assignments, 'conv_new', 30)
    expect(r.type).toBe('spawn')
    expect(r.workerIdx).toBe(10)

    // Simulate: worker[10] spawned and added
    workers.push({ idx: 10, convKey: 'conv_new', busy: true, lastActivityAt: now, ready: true })
    assignments.set('conv_new', 10)

    // Later: conv_new done, worker[10] cleared
    markIdle(workers, assignments, 'conv_new')
    clearWorker(workers, assignments, 'conv_new')
    workers[10].lastActivityAt = now - 300_001 // 5 min ago

    // Kill check: 11 workers > minWorkers(10) → worker[10] killable
    const killable = findKillableWorkers(workers, 300_000, 10, now)
    expect(killable).toEqual([10])
  })
})
