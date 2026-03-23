import { describe, test, expect } from 'bun:test'

/**
 * Tests that verify the system prompt contains all required safety rules
 * and skill overrides for unattended workers.
 *
 * We replicate the _buildClaudeCmd logic to test the prompt content.
 */

function buildSafetyRules(): string {
  return [
    '你运行在无人值守的飞书 bot worker 中，终端没有人可以回应交互确认。',
    '禁止执行任何需要终端交互确认的操作，包括但不限于：修改 ~/.mcp.json、修改 ~/.claude/ 配置、安装全局包。',
    '如果用户要求这类操作，告诉他们在自己的终端里执行。',
    '当用户要求管理 bot 的群权限或管理员时，必须使用 manage_access tool。绝对不要使用 /lark-customized:access skill 来管理权限——那个 skill 只管理消息通道的 access.json，不是 bot 的群权限和管理员。manage_access 支持 add_group/remove_group/list_groups/add_admin/remove_admin/list_admins。权限管理只能在私聊中操作，如果用户在群里发管理请求，提示他们私聊你。',
    '需要浏览器时，必须使用 Chrome MCP（chrome-devtools 或 Claude_in_Chrome），禁止使用无头浏览器（headless）。',
    '禁止手动 react 状态 emoji（👀、✅、🤔等）到用户消息上，系统已自动管理状态 emoji。只有表达语义时才用 react tool。',
    '优先使用已安装的 skill（/skill-name）来完成任务，不要自己从零实现 skill 已覆盖的功能。',
    '不确定飞书 API 是否支持某功能时，先用 Context7 查文档或使用相关 skill，禁止凭猜测回答"不支持"或"做不到"。',
  ].join(' ')
}

describe('system prompt safety rules', () => {
  const prompt = buildSafetyRules()

  test('contains unattended worker warning', () => {
    expect(prompt).toContain('无人值守')
    expect(prompt).toContain('终端没有人可以回应交互确认')
  })

  test('blocks interactive operations', () => {
    expect(prompt).toContain('禁止执行任何需要终端交互确认的操作')
    expect(prompt).toContain('~/.mcp.json')
    expect(prompt).toContain('~/.claude/')
  })

  test('overrides lark-customized:access skill for manage_access', () => {
    expect(prompt).toContain('必须使用 manage_access tool')
    expect(prompt).toContain('绝对不要使用 /lark-customized:access skill')
    expect(prompt).toContain('add_group')
    expect(prompt).toContain('remove_group')
    expect(prompt).toContain('add_admin')
    expect(prompt).toContain('remove_admin')
    expect(prompt).toContain('list_admins')
    expect(prompt).toContain('list_groups')
  })

  test('enforces DM-only for manage_access', () => {
    expect(prompt).toContain('只能在私聊中操作')
  })

  test('requires Chrome MCP, blocks headless', () => {
    expect(prompt).toContain('Chrome MCP')
    expect(prompt).toContain('禁止使用无头浏览器')
  })

  test('blocks manual status emoji reactions', () => {
    expect(prompt).toContain('禁止手动 react 状态 emoji')
    expect(prompt).toContain('系统已自动管理状态 emoji')
  })

  test('prioritizes skills', () => {
    expect(prompt).toContain('优先使用已安装的 skill')
  })

  test('requires doc lookup before claiming unsupported', () => {
    expect(prompt).toContain('先用 Context7 查文档')
    expect(prompt).toContain('禁止凭猜测回答')
  })
})
