# Development Guidelines

## Third-Party API Development Rules

**MANDATORY**: Before implementing ANY third-party API call, SDK method, or integration feature:

1. **Check official documentation first** — use the vendor's open platform docs or Context7
2. **Never guess** API parameters, enum values, request/response formats, or method signatures
3. **If you can't find it, ask the user** — don't assume or invent

This applies to ALL external services, including but not limited to:
- **Lark/Feishu**: [Feishu Open Platform](https://open.feishu.cn/document/) or Context7 (`/websites/open_feishu_cn_document`)
- **Discord**: [Discord Developer Portal](https://discord.com/developers/docs) or Context7
- **Claude Code CLI**: Check `claude --help` or [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code)
- **MCP Protocol**: [MCP SDK docs](https://modelcontextprotocol.io)
- **Any npm package**: Check the package's README or Context7 before using its API

### Common mistakes to avoid
- ❌ Inventing API enum values that don't exist (e.g., `raw_interactive` is not a real Lark msg_type)
- ❌ Guessing SDK method signatures without checking docs
- ❌ Assuming one platform's API works the same as another's
- ❌ Using deprecated or non-existent endpoints

## Lark/Feishu API

### Supported msg_type values (for im.message.create)
- `text` — plain text
- `post` — rich text
- `image` — image
- `file` — file attachment
- `audio` — voice
- `media` — video
- `sticker` — sticker
- `interactive` — message card (JSON 2.0)
- `share_chat` — group card
- `share_user` — personal card
- `system` — system message

### Reply tool msg_type usage
The reply tool's `msg_type` parameter controls the output format. AI should choose the best type per scenario:
- `text` — short replies ("好的", "收到"), content: `{"text": "..."}`
- `post` — rich text with formatting, content: `{"zh_cn": {"title": "...", "content": [[...]]}}`
- `image` — send image by image_key, content: `{"image_key": "img_xxx"}`
- `file` — send file by file_key, content: `{"file_key": "file_xxx"}`
- `interactive` — (default) markdown card or custom card JSON
- Other types: `audio`, `media`, `sticker`, `share_chat`, `share_user`

### Card JSON auto-detection
When sending `interactive` messages, if the text content is valid card JSON (contains `schema`, `config`, `header`, or `elements` keys), it is sent as-is. Otherwise it is wrapped in a markdown card automatically.

## Troubleshooting: Known Issues

### 话题群回复创建新话题（而非在原话题内回复）

**症状**: Bot 在话题群里回复消息时，不在原话题下回复，而是创建了一个新话题。

**排查步骤**:
1. 检查 daemon 日志（`~/.lark-dispatcher/logs/`），看回复时是否有 `tool-call: reply` 记录
2. 如果有 tool-call 但仍创建新话题 → 检查 `api.ts` 的 `reply_in_thread` 参数是否正确传入
3. **如果日志里完全没有 tool-call 记录但飞书上有回复** → Worker 绕过了 daemon，直接通过全局 lark-mcp 发送了消息

**根因**: Worker 是 Claude Code CLI 进程，会继承 `~/.mcp.json` 中的全局 MCP 配置（包括 `lark-mcp`）。Worker 的 Claude 模型可能选择 `lark-mcp` 的 `im.message.create` 直接发消息，绕过 daemon 的 reply 路径。`im.message.create` 在话题群中 = 创建新话题。

**防护措施（当前已实施）**:
- `pool.ts` 中 `--disallowed-tools` 禁用 lark-mcp 的消息发送工具（`im.message.create`、`im.message.reply` 及其 v1 变体）
- Worker system prompt 中明确禁止使用 lark-mcp 发送消息
- 所有飞书消息必须通过 `reply` 工具 → daemon → `api.ts`（带 `reply_in_thread: true`）

**如果问题复发**: 检查 `~/.mcp.json` 是否新增了其他能发飞书消息的 MCP server，并在 `--disallowed-tools` 中补充禁用。

## Project Structure

```
plugin-standalone/    — Channel plugin, direct Lark WebSocket (single terminal)
plugin-dispatcher/    — Channel plugin, localhost HTTP bridge (for daemon mode)
dispatcher/           — Daemon with worker pool management
```

## Code Conventions

- Runtime config: `~/.lark-dispatcher/config.json`
- Plugin state: `~/.claude/channels/lark/`
- Logs: `~/.lark-dispatcher/logs/`
- Inbox (downloaded images): `~/.lark-dispatcher/inbox/`
- Session persistence: `~/.lark-dispatcher/sessions.json`

## Testing

After code changes:
1. Sync plugin: `cp plugin-dispatcher/server.ts ~/.claude/plugins/marketplaces/local-channels/external_plugins/lark-customized/server.ts`
2. Run tests: `cd dispatcher && bun test`
3. Restart daemon: `cd dispatcher && bun run src/index.ts start`
4. Send test message in Lark

### Test Requirements

Every code change MUST:
1. **Add or update test cases** for all new/modified functionality
2. **Update `TEST_COVERAGE.md`** with new test entries in the feature → test case matrix
3. **All tests must pass** before committing (`bun test` — 0 failures)
4. Test files go in `dispatcher/tests/`, named `<module>.test.ts`
