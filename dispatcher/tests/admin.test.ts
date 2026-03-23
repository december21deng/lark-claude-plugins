import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AdminManager } from '../src/admin.js'
import type { LarkConfig, AccessConfig } from '../src/types.js'

const TEST_DIR = join(tmpdir(), `admin-test-${Date.now()}`)

function makeLarkConfig(superadmins: string[] = []): LarkConfig {
  return {
    appId: 'test', appSecret: 'test', domain: 'feishu',
    superadmins,
    access: {
      dmPolicy: 'open', allowFrom: [],
      groups: {}, groupAutoReply: [],
    },
  }
}

describe('AdminManager', () => {
  let mgr: AdminManager

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  // ── Admin management ──

  test('superadmin can add admin', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    expect(result.ok).toBe(true)
    expect(mgr.isAdmin('ou_tom')).toBe(true)
  })

  test('non-superadmin cannot add admin', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_random')
    expect(result.ok).toBe(false)
  })

  test('superadmin can remove admin', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    const result = mgr.execute({ action: 'remove_admin', target_id: 'ou_tom' }, 'ou_super')
    expect(result.ok).toBe(true)
    expect(mgr.isAdmin('ou_tom')).toBe(false)
  })

  test('remove non-existent admin fails', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'remove_admin', target_id: 'ou_nobody' }, 'ou_super')
    expect(result.ok).toBe(false)
  })

  test('list admins includes superadmins and admins', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    const result = mgr.execute({ action: 'list_admins' }, 'ou_super')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('ou_super')
    expect(result.message).toContain('ou_tom')
  })

  // ── Group management ──

  test('admin can add group', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    const result = mgr.execute({ action: 'add_group', target_id: 'oc_group1' }, 'ou_tom')
    expect(result.ok).toBe(true)
  })

  test('non-admin cannot add group', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_group', target_id: 'oc_group1' }, 'ou_random')
    expect(result.ok).toBe(false)
  })

  test('add group with auto_reply option', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute(
      { action: 'add_group', target_id: 'oc_g1', options: { auto_reply: true } },
      'ou_super',
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('自动回复')
  })

  test('add group with require_mention option', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute(
      { action: 'add_group', target_id: 'oc_g2', options: { require_mention: true } },
      'ou_super',
    )
    expect(result.ok).toBe(true)
    expect(result.message).toContain('需要@提及')
  })

  test('remove group', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super')
    const result = mgr.execute({ action: 'remove_group', target_id: 'oc_g1' }, 'ou_super')
    expect(result.ok).toBe(true)
  })

  test('remove non-existent group fails', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'remove_group', target_id: 'oc_nope' }, 'ou_super')
    expect(result.ok).toBe(false)
  })

  test('list groups', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super')
    mgr.execute({ action: 'add_group', target_id: 'oc_g2', options: { auto_reply: true } }, 'ou_super')
    const result = mgr.execute({ action: 'list_groups' }, 'ou_super')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('oc_g1')
    expect(result.message).toContain('oc_g2')
  })

  // ── Live access config ──

  test('getLiveAccessConfig merges dynamic groups', () => {
    const config = makeLarkConfig(['ou_super'])
    mgr = new AdminManager(config, TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_dynamic', options: { auto_reply: true } }, 'ou_super')

    const live = mgr.getLiveAccessConfig(config.access)
    expect(live.groups['oc_dynamic']).toBeDefined()
    expect(live.groupAutoReply).toContain('oc_dynamic')
  })

  // ── Persistence ──

  test('admins persist to file', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')

    const file = join(TEST_DIR, 'admins.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    expect(data).toContain('ou_tom')
  })

  test('groups persist to file', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super')

    const file = join(TEST_DIR, 'groups.json')
    expect(existsSync(file)).toBe(true)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    expect(data['oc_g1']).toBeDefined()
  })

  test('reload from persisted files', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super')

    // Create new instance — should load from files
    const mgr2 = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    expect(mgr2.isAdmin('ou_tom')).toBe(true)
    const result = mgr2.execute({ action: 'list_groups' }, 'ou_super')
    expect(result.message).toContain('oc_g1')
  })

  // ── Edge cases ──

  test('unknown action returns error', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'unknown_action' }, 'ou_super')
    expect(result.ok).toBe(false)
  })

  test('missing target_id returns error', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_group' }, 'ou_super')
    expect(result.ok).toBe(false)
  })

  test('duplicate admin add is idempotent', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    const result = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('已经是')
  })

  // ── Chat mode auto-detect ──

  test('updateGroupChatMode changes topic group to auto-reply', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_topic1' }, 'ou_super')
    // Default is group mode with requireMention=true
    const before = mgr.getLiveAccessConfig(makeLarkConfig(['ou_super']).access)
    expect(before.groups['oc_topic1']?.requireMention).toBe(true)

    // Auto-detect updates to topic mode → requireMention=false
    mgr.updateGroupChatMode('oc_topic1', 'topic')
    const after = mgr.getLiveAccessConfig(makeLarkConfig(['ou_super']).access)
    expect(after.groups['oc_topic1']?.requireMention).toBe(false)
    expect(after.groupAutoReply).toContain('oc_topic1')
  })

  test('updateGroupChatMode on unknown group is no-op', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    // Should not throw
    mgr.updateGroupChatMode('oc_unknown', 'topic')
    const config = mgr.getLiveAccessConfig(makeLarkConfig(['ou_super']).access)
    expect(config.groups['oc_unknown']).toBeUndefined()
  })

  test('duplicate group add overwrites config', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_g1', options: { require_mention: true } }, 'ou_super')
    mgr.execute({ action: 'add_group', target_id: 'oc_g1', options: { auto_reply: true } }, 'ou_super')
    const config = mgr.getLiveAccessConfig(makeLarkConfig(['ou_super']).access)
    expect(config.groups['oc_g1']?.requireMention).toBe(false) // overwritten to auto_reply
  })

  test('superadmin cannot be removed via remove_admin', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'remove_admin', target_id: 'ou_super' }, 'ou_super')
    expect(result.ok).toBe(false) // superadmin is not in _admins list
  })

  test('admin can list groups but cannot add admin', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_admin' }, 'ou_super')

    // Admin can list
    const listResult = mgr.execute({ action: 'list_groups' }, 'ou_admin')
    expect(listResult.ok).toBe(true)

    // Admin cannot add admin
    const addResult = mgr.execute({ action: 'add_admin', target_id: 'ou_hacker' }, 'ou_admin')
    expect(addResult.ok).toBe(false)
  })

  // ── DM-only enforcement ──

  test('rejects add_admin in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
  })

  test('rejects remove_admin in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super', 'private')
    const result = mgr.execute({ action: 'remove_admin', target_id: 'ou_tom' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
    expect(mgr.isAdmin('ou_tom')).toBe(true)
  })

  test('rejects add_group in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
  })

  test('rejects remove_group in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super', 'private')
    const result = mgr.execute({ action: 'remove_group', target_id: 'oc_g1' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
  })

  test('rejects list_admins in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'list_admins' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
  })

  test('rejects list_groups in group chat', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const result = mgr.execute({ action: 'list_groups' }, 'ou_super', 'group')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('私聊')
  })

  test('allows all actions in private chat (default)', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const r1 = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super')
    expect(r1.ok).toBe(true)
    const r2 = mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super')
    expect(r2.ok).toBe(true)
    const r3 = mgr.execute({ action: 'list_admins' }, 'ou_super')
    expect(r3.ok).toBe(true)
  })

  test('allows all actions with explicit private chatType', () => {
    mgr = new AdminManager(makeLarkConfig(['ou_super']), TEST_DIR)
    const r1 = mgr.execute({ action: 'add_admin', target_id: 'ou_tom' }, 'ou_super', 'private')
    expect(r1.ok).toBe(true)
    const r2 = mgr.execute({ action: 'add_group', target_id: 'oc_g1' }, 'ou_super', 'private')
    expect(r2.ok).toBe(true)
  })
})
