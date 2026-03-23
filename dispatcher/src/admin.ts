/**
 * Admin & group permission management.
 *
 * Two-level hierarchy:
 *   superadmin (config.json, immutable) — can manage admins + groups
 *   admin (admins.json, persisted)      — can manage groups
 *
 * All management happens via natural language → Claude → manage_access tool-call.
 * Only allowed in private chat (DM).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { AccessConfig, LarkConfig } from './types.js'
import { log } from './utils/logger.js'

const TAG = 'admin'

export interface GroupConfig {
  chatMode: 'group' | 'topic'
  requireMention: boolean
}

export interface ManageAccessArgs {
  action: string
  target_id?: string
  options?: {
    auto_reply?: boolean
    require_mention?: boolean
  }
}

export class AdminManager {
  private _superadmins: string[]
  private _admins: string[] = []
  private _groups: Record<string, GroupConfig> = {}
  private _dataDir: string
  private _adminsFile: string
  private _groupsFile: string

  constructor(config: LarkConfig, dataDir: string) {
    this._superadmins = config.superadmins ?? []
    this._dataDir = dataDir
    this._adminsFile = join(dataDir, 'admins.json')
    this._groupsFile = join(dataDir, 'groups.json')

    mkdirSync(dataDir, { recursive: true })
    this._loadAdmins()
    this._loadGroups()

    log.info(TAG, `Initialized: ${this._superadmins.length} superadmins, ${this._admins.length} admins, ${Object.keys(this._groups).length} groups`)
  }

  /** Execute a manage_access action. Returns { ok, message }.
   *  chatType must be 'private' — all manage_access operations are DM-only. */
  execute(
    args: ManageAccessArgs,
    senderId: string,
    chatType: 'private' | 'group' = 'private',
  ): { ok: boolean; message: string } {
    // Hard gate: manage_access is DM-only
    if (chatType !== 'private') {
      log.info(TAG, `manage_access rejected: chatType=${chatType} (DM-only)`)
      return { ok: false, message: '权限管理操作只能在私聊中进行，请私聊我来管理群权限和管理员。' }
    }

    const { action, target_id, options } = args

    switch (action) {
      case 'list_admins':
        if (!this._isAdmin(senderId)) return { ok: false, message: '权限不足：只有管理员可以查看管理员列表' }
        return { ok: true, message: this._listAdmins() }

      case 'add_admin':
        if (!this._isSuperAdmin(senderId)) return { ok: false, message: '权限不足：只有超级管理员可以添加管理员' }
        if (!target_id) return { ok: false, message: '缺少 target_id（admin 的 open_id）' }
        return this._addAdmin(target_id)

      case 'remove_admin':
        if (!this._isSuperAdmin(senderId)) return { ok: false, message: '权限不足：只有超级管理员可以移除管理员' }
        if (!target_id) return { ok: false, message: '缺少 target_id（admin 的 open_id）' }
        return this._removeAdmin(target_id)

      case 'list_groups':
        if (!this._isAdmin(senderId)) return { ok: false, message: '权限不足：只有管理员可以查看授权群列表' }
        return { ok: true, message: this._listGroups() }

      case 'add_group':
        if (!this._isAdmin(senderId)) return { ok: false, message: '权限不足：只有管理员可以添加群' }
        if (!target_id) return { ok: false, message: '缺少 target_id（群的 chat_id）' }
        return this._addGroup(target_id, options)

      case 'remove_group':
        if (!this._isAdmin(senderId)) return { ok: false, message: '权限不足：只有管理员可以移除群' }
        if (!target_id) return { ok: false, message: '缺少 target_id（群的 chat_id）' }
        return this._removeGroup(target_id)

      default:
        return { ok: false, message: `未知操作: ${action}` }
    }
  }

  /** Get live AccessConfig merging static config with dynamic groups. */
  getLiveAccessConfig(baseAccess: AccessConfig): AccessConfig {
    // Merge dynamic groups into static access config
    const mergedGroups = { ...baseAccess.groups }
    const mergedAutoReply = [...baseAccess.groupAutoReply]

    for (const [chatId, cfg] of Object.entries(this._groups)) {
      mergedGroups[chatId] = { requireMention: cfg.requireMention }
      if (!cfg.requireMention && !mergedAutoReply.includes(chatId)) {
        mergedAutoReply.push(chatId)
      }
    }

    return {
      ...baseAccess,
      groups: mergedGroups,
      groupAutoReply: mergedAutoReply,
    }
  }

  isSuperAdmin(id: string): boolean { return this._isSuperAdmin(id) }
  isAdmin(id: string): boolean { return this._isAdmin(id) }

  // ── Private ──

  private _isSuperAdmin(id: string): boolean {
    return this._superadmins.includes(id)
  }

  private _isAdmin(id: string): boolean {
    return this._superadmins.includes(id) || this._admins.includes(id)
  }

  private _listAdmins(): string {
    const lines = ['管理员列表：']
    if (this._superadmins.length) {
      lines.push('超级管理员：')
      for (const id of this._superadmins) lines.push(`  - ${id}`)
    }
    if (this._admins.length) {
      lines.push('管理员：')
      for (const id of this._admins) lines.push(`  - ${id}`)
    }
    if (!this._superadmins.length && !this._admins.length) {
      lines.push('(无)')
    }
    return lines.join('\n')
  }

  private _addAdmin(id: string): { ok: boolean; message: string } {
    if (this._admins.includes(id)) return { ok: true, message: `${id} 已经是管理员` }
    this._admins.push(id)
    this._saveAdmins()
    log.info(TAG, `Admin added: ${id}`)
    return { ok: true, message: `已添加管理员: ${id}` }
  }

  private _removeAdmin(id: string): { ok: boolean; message: string } {
    const idx = this._admins.indexOf(id)
    if (idx === -1) return { ok: false, message: `${id} 不是管理员` }
    this._admins.splice(idx, 1)
    this._saveAdmins()
    log.info(TAG, `Admin removed: ${id}`)
    return { ok: true, message: `已移除管理员: ${id}` }
  }

  private _listGroups(): string {
    const entries = Object.entries(this._groups)
    if (!entries.length) return '当前没有授权群'
    const lines = ['授权群列表：']
    for (const [chatId, cfg] of entries) {
      const mode = cfg.requireMention ? '需要@提及' : '自动回复'
      const type = cfg.chatMode === 'topic' ? '话题群' : '普通群'
      lines.push(`  - ${chatId} (${type}, ${mode})`)
    }
    return lines.join('\n')
  }

  private _addGroup(
    chatId: string,
    options?: { auto_reply?: boolean; require_mention?: boolean },
  ): { ok: boolean; message: string } {
    // Default: topic groups auto-reply, regular groups require mention
    // This will be overridden if chatMode is auto-detected via API
    const chatMode: 'group' | 'topic' = 'group' // default, updated later via API
    let requireMention = true // default for regular groups

    // Explicit overrides from options
    if (options?.require_mention !== undefined) requireMention = options.require_mention
    if (options?.auto_reply !== undefined) requireMention = !options.auto_reply

    this._groups[chatId] = { chatMode, requireMention }
    this._saveGroups()

    const mode = requireMention ? '需要@提及' : '自动回复'
    log.info(TAG, `Group added: ${chatId} (${mode})`)
    return { ok: true, message: `已添加群 ${chatId} (${mode})` }
  }

  /** Update group config with auto-detected chat mode. */
  updateGroupChatMode(chatId: string, chatMode: 'group' | 'topic'): void {
    const cfg = this._groups[chatId]
    if (!cfg) return
    cfg.chatMode = chatMode
    // Apply default based on chat mode if not explicitly set
    if (chatMode === 'topic') {
      cfg.requireMention = false
    }
    this._saveGroups()
    log.info(TAG, `Group ${chatId} chatMode updated to ${chatMode}`)
  }

  private _removeGroup(chatId: string): { ok: boolean; message: string } {
    if (!this._groups[chatId]) return { ok: false, message: `${chatId} 不在授权群列表中` }
    delete this._groups[chatId]
    this._saveGroups()
    log.info(TAG, `Group removed: ${chatId}`)
    return { ok: true, message: `已移除群: ${chatId}` }
  }

  private _loadAdmins(): void {
    try {
      if (existsSync(this._adminsFile)) {
        this._admins = JSON.parse(readFileSync(this._adminsFile, 'utf8'))
      }
    } catch (e) {
      log.warn(TAG, `Failed to load admins.json: ${e}`)
    }
  }

  private _loadGroups(): void {
    try {
      if (existsSync(this._groupsFile)) {
        this._groups = JSON.parse(readFileSync(this._groupsFile, 'utf8'))
      }
    } catch (e) {
      log.warn(TAG, `Failed to load groups.json: ${e}`)
    }
  }

  private _saveAdmins(): void {
    try {
      writeFileSync(this._adminsFile, JSON.stringify(this._admins, null, 2))
    } catch (e) {
      log.error(TAG, `Failed to save admins.json: ${e}`)
    }
  }

  private _saveGroups(): void {
    try {
      writeFileSync(this._groupsFile, JSON.stringify(this._groups, null, 2))
    } catch (e) {
      log.error(TAG, `Failed to save groups.json: ${e}`)
    }
  }
}
