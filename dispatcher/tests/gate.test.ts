import { describe, test, expect } from 'bun:test'
import type { AccessConfig } from '../src/types.js'

/**
 * Tests for gate() access control (receiver.ts).
 * Replicated here for isolated testing.
 */

type GateResult =
  | { action: 'allow' }
  | { action: 'drop' }
  | { action: 'pair'; code: string }

function gate(
  chatId: string,
  chatType: 'private' | 'group',
  senderId: string,
  mentionedBot: boolean,
  access: AccessConfig,
): GateResult {
  if (chatType === 'private') {
    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    if (access.dmPolicy === 'open') return { action: 'allow' }
    if (access.allowFrom.includes(senderId)) return { action: 'allow' }
    if (access.dmPolicy === 'pairing') {
      const code = Math.random().toString(16).slice(2, 8)
      return { action: 'pair', code }
    }
    return { action: 'drop' }
  }

  // Group chat
  const isAutoReply = access.groupAutoReply.includes(chatId)
  const groupCfg = access.groups[chatId]

  if (!isAutoReply && !groupCfg) return { action: 'drop' }
  if (!isAutoReply && groupCfg?.requireMention && !mentionedBot) return { action: 'drop' }
  if (groupCfg?.allowFrom?.length && !groupCfg.allowFrom.includes(senderId)) return { action: 'drop' }

  return { action: 'allow' }
}

// ── Helper ──

function makeAccess(overrides?: Partial<AccessConfig>): AccessConfig {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    groupAutoReply: [],
    ...overrides,
  }
}

// ── Tests: DM policy ──

describe('gate: DM policy', () => {
  test('dmPolicy=open allows all DMs', () => {
    const result = gate('chat_1', 'private', 'ou_anyone', false, makeAccess({ dmPolicy: 'open' }))
    expect(result.action).toBe('allow')
  })

  test('dmPolicy=disabled drops all DMs', () => {
    const result = gate('chat_1', 'private', 'ou_anyone', false, makeAccess({ dmPolicy: 'disabled' }))
    expect(result.action).toBe('drop')
  })

  test('dmPolicy=pairing returns pair for unknown sender', () => {
    const result = gate('chat_1', 'private', 'ou_stranger', false, makeAccess({ dmPolicy: 'pairing' }))
    expect(result.action).toBe('pair')
    expect((result as any).code).toBeDefined()
  })

  test('dmPolicy=pairing allows allowlisted sender', () => {
    const result = gate('chat_1', 'private', 'ou_friend', false,
      makeAccess({ dmPolicy: 'pairing', allowFrom: ['ou_friend'] }))
    expect(result.action).toBe('allow')
  })

  test('dmPolicy=allowlist drops unknown sender', () => {
    const result = gate('chat_1', 'private', 'ou_stranger', false,
      makeAccess({ dmPolicy: 'allowlist' as any }))
    expect(result.action).toBe('drop')
  })

  test('dmPolicy=allowlist allows allowlisted sender', () => {
    const result = gate('chat_1', 'private', 'ou_vip', false,
      makeAccess({ dmPolicy: 'allowlist' as any, allowFrom: ['ou_vip'] }))
    expect(result.action).toBe('allow')
  })
})

// ── Tests: Group policy ──

describe('gate: group policy', () => {
  test('unknown group without mention is dropped', () => {
    const result = gate('oc_unknown', 'group', 'ou_user', false, makeAccess())
    expect(result.action).toBe('drop')
  })

  test('autoReply group allows without mention', () => {
    const result = gate('oc_auto', 'group', 'ou_user', false,
      makeAccess({ groupAutoReply: ['oc_auto'] }))
    expect(result.action).toBe('allow')
  })

  test('configured group with requireMention=true drops without mention', () => {
    const result = gate('oc_strict', 'group', 'ou_user', false,
      makeAccess({ groups: { 'oc_strict': { requireMention: true } } }))
    expect(result.action).toBe('drop')
  })

  test('configured group with requireMention=true allows with mention', () => {
    const result = gate('oc_strict', 'group', 'ou_user', true,
      makeAccess({ groups: { 'oc_strict': { requireMention: true } } }))
    expect(result.action).toBe('allow')
  })

  test('configured group with requireMention=false allows without mention', () => {
    const result = gate('oc_open', 'group', 'ou_user', false,
      makeAccess({ groups: { 'oc_open': { requireMention: false } } }))
    expect(result.action).toBe('allow')
  })

  test('group with allowFrom restricts to specific senders', () => {
    const result = gate('oc_restricted', 'group', 'ou_outsider', true,
      makeAccess({ groups: { 'oc_restricted': { requireMention: false, allowFrom: ['ou_insider'] } } }))
    expect(result.action).toBe('drop')
  })

  test('group with allowFrom allows listed sender', () => {
    const result = gate('oc_restricted', 'group', 'ou_insider', false,
      makeAccess({ groups: { 'oc_restricted': { requireMention: false, allowFrom: ['ou_insider'] } } }))
    expect(result.action).toBe('allow')
  })

  test('autoReply overrides requireMention in groups config', () => {
    // Group is in both groupAutoReply AND groups with requireMention=true
    // autoReply should win
    const result = gate('oc_both', 'group', 'ou_user', false,
      makeAccess({
        groupAutoReply: ['oc_both'],
        groups: { 'oc_both': { requireMention: true } },
      }))
    expect(result.action).toBe('allow')
  })
})

// ── Tests: dynamic groups (from AdminManager) ──

describe('gate: dynamic groups via AdminManager', () => {
  test('dynamically added group with requireMention=true works', () => {
    // Simulates AdminManager.getLiveAccessConfig() merging dynamic groups
    const liveAccess = makeAccess({
      groups: { 'oc_dynamic': { requireMention: true } },
    })
    expect(gate('oc_dynamic', 'group', 'ou_user', false, liveAccess).action).toBe('drop')
    expect(gate('oc_dynamic', 'group', 'ou_user', true, liveAccess).action).toBe('allow')
  })

  test('dynamically added autoReply group works', () => {
    const liveAccess = makeAccess({
      groupAutoReply: ['oc_dynamic_auto'],
      groups: { 'oc_dynamic_auto': { requireMention: false } },
    })
    expect(gate('oc_dynamic_auto', 'group', 'ou_user', false, liveAccess).action).toBe('allow')
  })
})
