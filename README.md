# Lark Claude Plugins

[中文文档](./README_CN.md) | [Design Doc](./DESIGN.md) | [设计文档](./DESIGN_CN.md)

Chat with Claude Code through Lark/Feishu. Two modes: simple standalone for personal use, or multi-worker dispatcher for teams.

## Features

### Core
- **Daemon + Worker Pool** -- tmux-based, up to 10 parallel Claude CLI workers
- **Lark WebSocket** -- real-time message receive/send via long connection
- **Interactive card replies** -- Markdown rendering with card JSON auto-detection
- **Typing emoji feedback** -- Emoji state machine -- Typing → OnIt → DONE lifecycle (openclaw-lark aligned)
- **Multi-session parallelism** -- different threads routed to different workers
- **Session isolation** -- eviction + `--resume` context recovery, no cross-talk
- **All remote MCPs** -- Clay, Gmail, Calendar, Context7, and all Claude Desktop MCPs
- **Image support** -- receive (download to inbox) + send (upload + image_key)
- **All Lark msg_type** -- text, post, image, file, interactive, audio, media, sticker, etc.
- **Card JSON auto-detection** -- raw card JSON sent as-is, plain text wrapped in markdown card; strict validation + text extraction fallback
- **Thread-aware routing** -- topic groups get per-thread workers
- **Slash commands** -- `/clear`, `/new`, `/status`, `/help`

### Emoji State Machine (v3)
Typing → OnIt → DONE/FACEPALM lifecycle, aligned with openclaw-lark:
- Typing emoji shown while Claude is processing
- OnIt emoji when actively working on the task
- DONE or FACEPALM on completion/failure

### Admin Management (v3)
Natural language group/admin management via `manage_access` tool:
- Two-level admin system: superadmin + admin
- Add/remove groups and admins through DM conversation
- No slash commands needed -- just describe what you want

### Session Persistence (v3)
Sessions survive daemon restarts via `--session-id` / `--resume`:
- Worker sessions stored with stable IDs
- Daemon restart resumes existing sessions without context loss

### Mention Resolution
`@_user_N` placeholders in Claude's replies replaced with real names + open_id before sending.

### Permission Forwarding (v2)
Claude's permission prompts forwarded to Lark as interactive cards:
- Allow/Deny buttons sent to the user in Lark
- Supports button click (`card.action.trigger_v1`) and text reply fallback ("允许"/"拒绝")
- 2-minute timeout with automatic denial

### Plugin Standalone Mode (v2)
Works independently without the dispatcher daemon:
- Direct Lark WebSocket connection from a single Claude CLI
- No tmux, no daemon, no worker pool needed

## Two Modes

### Standalone Mode (`plugin-standalone/`)

Single terminal, single Claude CLI, direct Lark WebSocket connection. Simple setup, no daemon needed.

```
Lark WebSocket -> Claude CLI (with all remote MCPs)
```

Best for: personal use, single conversation at a time.

### Dispatcher Mode (`plugin-dispatcher/` + `dispatcher/`)

Multi-worker daemon with process pool, session management, and context isolation. Supports N parallel conversations.

```
Lark -> Daemon (single WebSocket) -> Router -> Worker Pool (N Claude CLIs)
                                                    ^ each has full remote MCPs
```

Best for: team use, multiple concurrent conversations, auto-scaling.

## Why Two Modes?

Claude Code's remote MCPs (Clay, Gmail, Calendar, etc.) are `type: "sdk"` -- only available when Claude CLI runs as the **main process**. Standalone mode gives you the simplest setup. Dispatcher mode solves the problem of Lark only delivering messages to one WebSocket connection by having a daemon hold the single connection and route to multiple workers.

## Prerequisites

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) installed
- Lark self-built app (WebSocket mode)
- [tmux](https://github.com/tmux/tmux) (dispatcher mode only: `brew install tmux`)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/december21deng/lark-claude-plugins.git
cd lark-claude-plugins

# Standalone mode:
bash install.sh standalone

# Dispatcher mode:
bash install.sh dispatcher

# Both:
bash install.sh both
```

### 2. Configure Lark App

Create a self-built app on [Lark Open Platform](https://open.larksuite.com):

1. Create app -> get App ID and App Secret
2. Add capability -> Bot
3. Permissions -> enable:
   - `im:message` -- send/receive messages
   - `im:message:send_as_bot` -- send as bot
   - `im:resource` -- upload/download resources
   - `im:message.group_msg:readonly` -- receive all group messages (not just @mentions)
4. Events & Callbacks -> choose **Long Connection (WebSocket)** mode
5. Subscribe event -> `im.message.receive_v1`
6. Subscribe event -> `im.message.reaction.created_v1` and `im.message.reaction.deleted_v1`
7. Subscribe event -> `card.action.trigger` (required for permission forwarding buttons)

### 3a. Standalone: Set Credentials and Start

```bash
# Save credentials
mkdir -p ~/.claude/channels/lark
cat > ~/.claude/channels/lark/.env << EOF
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
EOF

# Start Claude with the standalone plugin
claude --dangerously-load-development-channels plugin:lark-standalone@local-channels
```

### 3b. Dispatcher: Configure and Start

```bash
# Edit config
cp config.example.json ~/.lark-dispatcher/config.json
vim ~/.lark-dispatcher/config.json

# Start daemon
cd dispatcher && bun run src/index.ts start
```

### 4. Verify

```bash
# Standalone: just send a message to your bot in Lark

# Dispatcher:
cd dispatcher && bun run src/index.ts status
tmux ls
tmux attach -t lark-worker-0  # Ctrl+B D to detach
tail -f ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log
```

## Usage

### Lark Commands (Dispatcher Mode)

| Command | Function |
|---------|----------|
| `/clear` | Clear current conversation, start fresh |
| `/new` | Same as /clear |
| `/status` | Show worker pool status |
| `/help` | Help |

### Multi-Session (Dispatcher Mode)

- **DM** -> each user's DM gets its own worker
- **Group thread** -> each thread gets its own worker
- **Group (no thread)** -> the whole group shares one worker
- Up to N parallel conversations (configure `maxWorkers`)
- **Activity-aware eviction (v4)**: never evicts workers actively processing a task
- When pool is full: STALE (idle >30min) evicted first, then IDLE (LRU), ACTIVE workers protected
- If all workers busy: message queued automatically, processed when a worker becomes available

### Access Control

Both modes support access control via `~/.claude/channels/lark/access.json`:

| Setting | Description |
|---------|-------------|
| `dmPolicy: "pairing"` | Requires pairing code (default) |
| `dmPolicy: "allowlist"` | Only allowlisted users |
| `dmPolicy: "disabled"` | DM disabled |
| `groupAutoReply: ["oc_xxx"]` | These groups reply without @mention |

Manage with the skill: `/lark-standalone:access` or `/lark-customized:access`

Dispatcher mode also supports `dmPolicy: "open"` in config.json for allowing all users.

#### Two-Level Admin System (v3)

| Role | Source | Can manage |
|------|--------|------------|
| superadmin | `config.json` (`lark.superadmins`) | admins + groups |
| admin | `admins.json` | groups |

All management via natural language in DM -- no slash commands needed. Send messages like "add group oc_xxx" or "remove admin ou_yyy" to the bot.

### Remote MCPs

Each Claude CLI instance automatically loads all connected remote MCPs:
Clay, Gmail, Google Calendar, Context7, and all MCPs connected in Claude Desktop.

## Testing

Unit tests covering all core modules:

```bash
cd dispatcher && bun test
```

All tests pass. Test files are in `dispatcher/tests/`, including:
- `pool-eviction.test.ts` — activity-aware eviction, tiered scheduling, pending queue
- `reaction-tracker.test.ts`, `admin.test.ts`, `emoji-resolve.test.ts`, `reply-threading.test.ts`

## Configuration Reference (Dispatcher)

| Field | Default | Description |
|-------|---------|-------------|
| `pool.maxWorkers` | 3 | Number of workers |
| `pool.basePort` | 7100 | Worker port range start |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API port |
| `lark.domain` | "feishu" | "feishu" or "lark" |
| `lark.superadmins` | [] | Array of open_ids with superadmin privileges |
| `log.level` | "info" | Log level |

## Stop (Dispatcher)

```bash
# Ctrl+C in daemon terminal, or:
cd dispatcher && bun run src/index.ts stop
```

## Code Structure

| Path | Responsibility |
|------|---------------|
| `plugin-standalone/server.ts` | Standalone plugin: direct Lark WebSocket + MCP tools |
| `plugin-dispatcher/server.ts` | Dispatcher plugin: localhost HTTP bridge + MCP notification |
| `dispatcher/src/daemon.ts` | Daemon entry, HTTP server, signal handling |
| `dispatcher/src/pool.ts` | Worker Pool: tmux management, assignment, eviction, resume |
| `dispatcher/src/router.ts` | Message routing: convKey, Mutex queuing, slash commands |
| `dispatcher/src/permission.ts` | Permission forwarding: interactive card with Allow/Deny buttons |
| `dispatcher/src/reaction-tracker.ts` | Emoji state machine (Typing → OnIt → DONE/FACEPALM) |
| `dispatcher/src/admin.ts` | Admin & group permission management |
| `dispatcher/src/session-store.ts` | Session persistence (sessions.json) |
| `dispatcher/src/gateways/lark/ws.ts` | Lark WebSocket + event handling |
| `dispatcher/src/gateways/lark/receiver.ts` | Message parsing + dedup + access control |
| `dispatcher/src/gateways/lark/api.ts` | Lark HTTP API (messages, reactions) |
| `dispatcher/tests/` | 117 unit tests (mutex, dedup, router, session-store, receiver, reaction-tracker, admin, emoji-resolve, reply-threading) |

## Troubleshooting

<details>
<summary>Messages not getting replies</summary>

```bash
# Standalone: check stderr output in terminal
# Dispatcher:
cd dispatcher && bun run src/index.ts status
curl http://localhost:7100/health
tail -50 ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log
```
</details>

<details>
<summary>Worker startup failure (Dispatcher)</summary>

```bash
tmux attach -t lark-worker-0
# Manual test:
LARK_DISPATCHER_PORT=7100 LARK_DAEMON_PORT=8900 claude \
  --dangerously-load-development-channels plugin:lark-customized@local-channels \
  --dangerously-skip-permissions
```
</details>

<details>
<summary>Port in use (Dispatcher)</summary>

```bash
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```
</details>

## License

MIT
