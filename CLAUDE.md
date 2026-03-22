# Development Guidelines

## Lark/Feishu API

**IMPORTANT**: Before implementing any Lark/Feishu feature or API call:
1. Check the [Feishu Open Platform docs](https://open.feishu.cn/document/) or [Lark Open Platform docs](https://open.larksuite.com/document/)
2. Use Context7 (`/websites/open_feishu_cn_document`) to query documentation
3. Do NOT guess API parameters, msg_type values, or endpoint formats

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
