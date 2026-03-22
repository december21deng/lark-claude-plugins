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
1. Sync plugin: `cp plugin-dispatcher/server.ts ~/.claude/plugins/cache/local-channels/lark-customized/0.0.1/server.ts`
2. Restart daemon: `cd dispatcher && bun run src/index.ts start`
3. Send test message in Lark
