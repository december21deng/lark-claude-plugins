import { describe, test, expect, beforeEach } from 'bun:test'

/**
 * Tests for v5 MCP readiness check logic in plugin-dispatcher/server.ts.
 *
 * Replicates the readiness + buffering logic as pure functions.
 */

// ── Simulated MCP readiness state ──

interface McpState {
  mcpReady: boolean
  pendingNotifications: Array<{ content: string; meta: Record<string, string> }>
}

function createMcpState(): McpState {
  return { mcpReady: false, pendingNotifications: [] }
}

/** Called when ListTools request is handled (MCP is ready). */
function onListTools(state: McpState): Array<{ content: string; meta: Record<string, string> }> {
  state.mcpReady = true
  const flushed = [...state.pendingNotifications]
  state.pendingNotifications = []
  return flushed
}

/** Called on /message endpoint. Returns true if message was delivered, false if buffered. */
function onMessage(
  state: McpState,
  content: string,
  meta: Record<string, string>,
): { delivered: boolean } {
  if (!state.mcpReady) {
    state.pendingNotifications.push({ content, meta })
    return { delivered: false }
  }
  return { delivered: true }
}

/** Called on /health endpoint. */
function healthCheck(state: McpState): { ready: boolean } {
  return { ready: state.mcpReady }
}

// ══════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════

describe('MCP readiness state', () => {
  let state: McpState

  beforeEach(() => {
    state = createMcpState()
  })

  test('initially not ready', () => {
    expect(state.mcpReady).toBe(false)
  })

  test('health check returns not ready initially', () => {
    expect(healthCheck(state)).toEqual({ ready: false })
  })

  test('health check returns ready after ListTools', () => {
    onListTools(state)
    expect(healthCheck(state)).toEqual({ ready: true })
  })
})

describe('message buffering', () => {
  let state: McpState

  beforeEach(() => {
    state = createMcpState()
  })

  test('message buffered when not ready', () => {
    const result = onMessage(state, 'hello', { chat_id: 'oc_1' })
    expect(result.delivered).toBe(false)
    expect(state.pendingNotifications.length).toBe(1)
    expect(state.pendingNotifications[0].content).toBe('hello')
  })

  test('message delivered when ready', () => {
    onListTools(state) // become ready
    const result = onMessage(state, 'hello', { chat_id: 'oc_1' })
    expect(result.delivered).toBe(true)
    expect(state.pendingNotifications.length).toBe(0)
  })

  test('multiple messages buffered before ready', () => {
    onMessage(state, 'msg_1', { chat_id: 'oc_1' })
    onMessage(state, 'msg_2', { chat_id: 'oc_2' })
    onMessage(state, 'msg_3', { chat_id: 'oc_3' })
    expect(state.pendingNotifications.length).toBe(3)
  })

  test('buffered messages flushed on ListTools', () => {
    onMessage(state, 'msg_1', { chat_id: 'oc_1' })
    onMessage(state, 'msg_2', { chat_id: 'oc_2' })

    const flushed = onListTools(state)
    expect(flushed.length).toBe(2)
    expect(flushed[0].content).toBe('msg_1')
    expect(flushed[1].content).toBe('msg_2')
    expect(state.pendingNotifications.length).toBe(0)
  })

  test('messages delivered normally after flush', () => {
    onMessage(state, 'buffered', { chat_id: 'oc_1' })
    onListTools(state)

    const result = onMessage(state, 'live', { chat_id: 'oc_2' })
    expect(result.delivered).toBe(true)
    expect(state.pendingNotifications.length).toBe(0)
  })

  test('flush with no buffered messages returns empty array', () => {
    const flushed = onListTools(state)
    expect(flushed).toEqual([])
  })
})

describe('full lifecycle', () => {
  test('server starts → messages buffered → ListTools → flush → normal delivery', () => {
    const state = createMcpState()

    // 1. Server starts, not ready
    expect(healthCheck(state)).toEqual({ ready: false })

    // 2. Messages arrive before MCP ready → buffered
    const r1 = onMessage(state, 'early_msg_1', { chat_id: 'oc_1' })
    const r2 = onMessage(state, 'early_msg_2', { chat_id: 'oc_2' })
    expect(r1.delivered).toBe(false)
    expect(r2.delivered).toBe(false)
    expect(state.pendingNotifications.length).toBe(2)

    // 3. Claude Code calls ListTools → MCP ready, flush buffered
    const flushed = onListTools(state)
    expect(flushed.length).toBe(2)
    expect(healthCheck(state)).toEqual({ ready: true })

    // 4. New messages delivered normally
    const r3 = onMessage(state, 'normal_msg', { chat_id: 'oc_3' })
    expect(r3.delivered).toBe(true)
    expect(state.pendingNotifications.length).toBe(0)
  })
})
