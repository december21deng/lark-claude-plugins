import { describe, test, expect } from 'bun:test'

/**
 * Tests for activity-aware worker pool eviction and scheduling (pool.ts).
 *
 * Replicates the core scheduling logic as pure functions to test without
 * tmux / Claude CLI dependencies.
 */

// ── Types (matches pool.ts / types.ts) ──

interface WorkerState {
  convKey: string | null
  busy: boolean
  lastActivityAt: number
}

interface PendingMessage {
  convKey: string
  text: string
  queuedAt: number
}

// ── Worker state classification ──

type WorkerClass = 'ACTIVE' | 'IDLE' | 'STALE' | 'EMPTY'

function classifyWorker(w: WorkerState, now: number, staleTimeoutMs: number): WorkerClass {
  if (w.convKey === null) return 'EMPTY'
  if (w.busy) return 'ACTIVE'
  if ((now - w.lastActivityAt) > staleTimeoutMs) return 'STALE'
  return 'IDLE'
}

// ── Tiered eviction candidate ──

function findEvictCandidate(
  workers: WorkerState[],
  assignments: Map<string, number>,
  lastUsed: Map<string, number>,
  now: number,
  staleTimeoutMs: number,
): string | null {
  // Phase 1: STALE (idle > staleTimeoutMs, LRU among stale)
  let candidate = ''
  let candidateTs = Infinity

  for (const [key, ts] of lastUsed) {
    if (!assignments.has(key)) continue
    const idx = assignments.get(key)!
    const w = workers[idx]
    if (w.busy) continue // skip ACTIVE
    if ((now - w.lastActivityAt) > staleTimeoutMs && ts < candidateTs) {
      candidate = key
      candidateTs = ts
    }
  }
  if (candidate) return candidate

  // Phase 2: IDLE (not busy, LRU)
  candidate = ''
  candidateTs = Infinity
  for (const [key, ts] of lastUsed) {
    if (!assignments.has(key)) continue
    const idx = assignments.get(key)!
    if (workers[idx].busy) continue // skip ACTIVE
    if (ts < candidateTs) {
      candidate = key
      candidateTs = ts
    }
  }
  if (candidate) return candidate

  // Phase 3: all ACTIVE → null
  return null
}

// ── Busy/Idle tracking ──

function markBusy(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].busy = true
}

function markIdle(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].busy = false
  workers[idx].lastActivityAt = Date.now()
}

// ── Pending queue ──

const MAX_PENDING = 50

function enqueuePending(queue: PendingMessage[], convKey: string, text: string): void {
  if (queue.length >= MAX_PENDING) {
    queue.shift() // drop oldest
  }
  queue.push({ convKey, text, queuedAt: Date.now() })
}

function dequeuePending(queue: PendingMessage[]): PendingMessage | undefined {
  return queue.shift()
}

// ── Tool-call heartbeat ──

function onToolCall(workers: WorkerState[], assignments: Map<string, number>, convKey: string): void {
  const idx = assignments.get(convKey)
  if (idx === undefined) return
  workers[idx].lastActivityAt = Date.now()
}

// ══════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════

describe('worker state classification', () => {
  const STALE_MS = 30 * 60 * 1000

  test('all busy workers classified as ACTIVE', () => {
    const w: WorkerState = { convKey: 'conv_1', busy: true, lastActivityAt: Date.now() }
    expect(classifyWorker(w, Date.now(), STALE_MS)).toBe('ACTIVE')
  })

  test('not-busy assigned worker classified as IDLE', () => {
    const w: WorkerState = { convKey: 'conv_1', busy: false, lastActivityAt: Date.now() }
    expect(classifyWorker(w, Date.now(), STALE_MS)).toBe('IDLE')
  })

  test('idle worker past staleTimeout classified as STALE', () => {
    const now = Date.now()
    const w: WorkerState = { convKey: 'conv_1', busy: false, lastActivityAt: now - STALE_MS - 1000 }
    expect(classifyWorker(w, now, STALE_MS)).toBe('STALE')
  })

  test('unassigned worker classified as EMPTY', () => {
    const w: WorkerState = { convKey: null, busy: false, lastActivityAt: 0 }
    expect(classifyWorker(w, Date.now(), STALE_MS)).toBe('EMPTY')
  })
})

describe('tiered eviction', () => {
  const STALE_MS = 30 * 60 * 1000
  const NOW = Date.now()

  test('evicts STALE worker before IDLE', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: false, lastActivityAt: NOW - 1000 },       // IDLE (recent)
      { convKey: 'conv_B', busy: false, lastActivityAt: NOW - STALE_MS - 5000 }, // STALE
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1]])
    const lastUsed = new Map([['conv_A', NOW - 1000], ['conv_B', NOW - STALE_MS - 5000]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBe('conv_B')
  })

  test('evicts IDLE worker (LRU) when no STALE', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: false, lastActivityAt: NOW - 5000 },  // IDLE, older
      { convKey: 'conv_B', busy: false, lastActivityAt: NOW - 1000 },  // IDLE, newer
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1]])
    const lastUsed = new Map([['conv_A', NOW - 5000], ['conv_B', NOW - 1000]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBe('conv_A')
  })

  test('never evicts ACTIVE (busy) worker', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: true, lastActivityAt: NOW - 100000 },  // ACTIVE (busy, old)
      { convKey: 'conv_B', busy: false, lastActivityAt: NOW - 1000 },   // IDLE (recent)
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1]])
    const lastUsed = new Map([['conv_A', NOW - 100000], ['conv_B', NOW - 1000]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBe('conv_B') // IDLE, not ACTIVE
  })

  test('returns null when all workers ACTIVE', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: true, lastActivityAt: NOW },
      { convKey: 'conv_B', busy: true, lastActivityAt: NOW },
      { convKey: 'conv_C', busy: true, lastActivityAt: NOW },
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1], ['conv_C', 2]])
    const lastUsed = new Map([['conv_A', NOW], ['conv_B', NOW], ['conv_C', NOW]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBeNull()
  })

  test('among multiple STALE, evicts LRU', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: false, lastActivityAt: NOW - STALE_MS - 10000 }, // STALE, older
      { convKey: 'conv_B', busy: false, lastActivityAt: NOW - STALE_MS - 3000 },  // STALE, newer
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1]])
    const lastUsed = new Map([['conv_A', NOW - STALE_MS - 10000], ['conv_B', NOW - STALE_MS - 3000]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBe('conv_A') // older STALE
  })

  test('among multiple IDLE, evicts LRU', () => {
    const workers: WorkerState[] = [
      { convKey: 'conv_A', busy: false, lastActivityAt: NOW - 5000 },
      { convKey: 'conv_B', busy: false, lastActivityAt: NOW - 2000 },
      { convKey: 'conv_C', busy: false, lastActivityAt: NOW - 8000 },
    ]
    const assignments = new Map([['conv_A', 0], ['conv_B', 1], ['conv_C', 2]])
    const lastUsed = new Map([['conv_A', NOW - 5000], ['conv_B', NOW - 2000], ['conv_C', NOW - 8000]])

    const victim = findEvictCandidate(workers, assignments, lastUsed, NOW, STALE_MS)
    expect(victim).toBe('conv_C') // oldest IDLE
  })
})

describe('markBusy / markIdle', () => {
  test('markBusy sets worker busy=true', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: false, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    markBusy(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(true)
  })

  test('markIdle sets worker busy=false', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: true, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(false)
  })

  test('markIdle updates lastActivityAt', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: true, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    const before = Date.now()
    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  test('markBusy on unknown convKey is no-op', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: false, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    markBusy(workers, assignments, 'conv_UNKNOWN')
    expect(workers[0].busy).toBe(false) // unchanged
  })

  test('markIdle on unknown convKey is no-op', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: true, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    markIdle(workers, assignments, 'conv_UNKNOWN')
    expect(workers[0].busy).toBe(true) // unchanged
  })
})

describe('pending message queue', () => {
  test('message queued when all workers ACTIVE', () => {
    const queue: PendingMessage[] = []
    enqueuePending(queue, 'conv_new', 'hello')
    expect(queue.length).toBe(1)
    expect(queue[0].convKey).toBe('conv_new')
  })

  test('pending message drained when worker becomes idle', () => {
    const queue: PendingMessage[] = []
    enqueuePending(queue, 'conv_A', 'msg_A')
    enqueuePending(queue, 'conv_B', 'msg_B')

    const msg = dequeuePending(queue)
    expect(msg?.convKey).toBe('conv_A')
    expect(queue.length).toBe(1)
  })

  test('pending queue processes in FIFO order', () => {
    const queue: PendingMessage[] = []
    enqueuePending(queue, 'conv_1', 'first')
    enqueuePending(queue, 'conv_2', 'second')
    enqueuePending(queue, 'conv_3', 'third')

    expect(dequeuePending(queue)?.convKey).toBe('conv_1')
    expect(dequeuePending(queue)?.convKey).toBe('conv_2')
    expect(dequeuePending(queue)?.convKey).toBe('conv_3')
  })

  test('queue drops oldest when exceeding max capacity', () => {
    const queue: PendingMessage[] = []
    // Fill to MAX_PENDING
    for (let i = 0; i < MAX_PENDING; i++) {
      enqueuePending(queue, `conv_${i}`, `msg_${i}`)
    }
    expect(queue.length).toBe(MAX_PENDING)

    // One more triggers drop
    enqueuePending(queue, 'conv_overflow', 'overflow')
    expect(queue.length).toBe(MAX_PENDING)
    expect(queue[0].convKey).toBe('conv_1') // conv_0 was dropped
    expect(queue[queue.length - 1].convKey).toBe('conv_overflow')
  })

  test('drain on empty queue is no-op', () => {
    const queue: PendingMessage[] = []
    const msg = dequeuePending(queue)
    expect(msg).toBeUndefined()
  })

  test('multiple idle events drain multiple queued messages', () => {
    const queue: PendingMessage[] = []
    enqueuePending(queue, 'conv_A', 'a')
    enqueuePending(queue, 'conv_B', 'b')
    enqueuePending(queue, 'conv_C', 'c')

    // Three drain events
    const a = dequeuePending(queue)
    const b = dequeuePending(queue)
    const c = dequeuePending(queue)
    const d = dequeuePending(queue) // empty

    expect(a?.convKey).toBe('conv_A')
    expect(b?.convKey).toBe('conv_B')
    expect(c?.convKey).toBe('conv_C')
    expect(d).toBeUndefined()
  })
})

describe('tool-call heartbeat', () => {
  test('any tool-call updates lastActivityAt', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: true, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    const before = Date.now()
    onToolCall(workers, assignments, 'conv_A')
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })

  test('reply tool-call marks worker idle and updates timestamp', () => {
    const workers: WorkerState[] = [{ convKey: 'conv_A', busy: true, lastActivityAt: 0 }]
    const assignments = new Map([['conv_A', 0]])

    const before = Date.now()
    // Simulate reply: markIdle (which also updates lastActivityAt)
    markIdle(workers, assignments, 'conv_A')
    expect(workers[0].busy).toBe(false)
    expect(workers[0].lastActivityAt).toBeGreaterThanOrEqual(before)
  })
})
