# Lark Dispatcher

[中文文档](./README_CN.md) | [Design Doc](./DESIGN.md) | [设计文档](./DESIGN_CN.md)

A hybrid dispatching system for Lark × Claude Code. Chat with Claude Code through Lark with multi-session parallelism, context isolation, and full remote MCP support (Clay, Gmail, Calendar, etc.).

## Architecture

```
Lark → Daemon (single WebSocket) → Router → Worker Pool (N Claude CLIs)
                                                    ↑ each has full remote MCPs
```

- **Daemon** holds the single Lark WebSocket connection, receives all messages
- **Worker Pool** consists of N Claude CLI processes running in tmux sessions
- Each Worker is a full Claude CLI main process, automatically loading all remote MCPs
- Different conversations (threads) are assigned to different Workers with complete context isolation
- On eviction: kill + `--resume` rebuilds context losslessly

## Why This Architecture?

Claude Code's remote MCPs (Clay, Gmail, Calendar, etc.) are `type: "sdk"` — only available when Claude CLI runs as the **main process**. Subprocess approaches (like NeoClaw's `--input-format stream-json`) cannot load these MCPs.

However, when each Claude CLI connects its own Lark WebSocket, Lark only delivers messages to one connection. The solution: a daemon holds the single WebSocket and routes messages to Workers via localhost HTTP.

```
                                     ┌→ Claude CLI Worker 1 :7100 (all MCPs)
Lark → Daemon (single WS) ────────┼→ Claude CLI Worker 2 :7101 (all MCPs)
                                     └→ Claude CLI Worker N :710N (all MCPs)
```

## Prerequisites

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) installed
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- Lark self-built app (WebSocket mode)

## Quick Start

### 1. Install

```bash
git clone https://github.com/december21deng/lark-claude-plugins.git
cd lark-claude-plugins
bash install.sh
```

### 2. Configure Lark App

Create a self-built app on [Lark Open Platform](https://open.larksuite.com):

1. Create app → get App ID and App Secret
2. Add capability → Bot
3. Permissions → enable:
   - `im:message` — send/receive messages
   - `im:message:send_as_bot` — send as bot
   - `im:resource` — upload/download resources
   - `im:message.group_msg:readonly` — receive all group messages (not just @mentions)
4. Events & Callbacks → choose **Long Connection (WebSocket)** mode
5. Subscribe event → `im.message.receive_v1`

### 3. Edit Configuration

```bash
cp config.example.json ~/.lark-dispatcher/config.json
vim ~/.lark-dispatcher/config.json
```

Fill in your `appId`, `appSecret`, `bin` path, and `groupAutoReply` chat IDs.

### 4. Start

```bash
bun run src/index.ts start
```

The daemon will automatically:
1. Pre-trust the workspace directory
2. Create N tmux worker sessions with auto-confirmation
3. Connect Lark WebSocket
4. Start receiving messages (as soon as the first worker is ready)

### 5. Verify

```bash
bun run src/index.ts status          # Check status
tmux ls                              # List workers
tmux attach -t lark-worker-0           # Attach to worker (Ctrl+B D to detach)
tail -f ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log  # View logs
```

## Usage

### Lark Commands

| Command | Function |
|---------|----------|
| `/clear` | Clear current conversation, start fresh |
| `/new` | Same as /clear |
| `/status` | Show worker pool status |
| `/help` | Help |

### Multi-Session

- **DM** → each user's DM gets its own worker
- **Group thread** → each thread gets its own worker
- **Group (no thread)** → the whole group shares one worker
- Up to N parallel conversations (configure `maxWorkers`)
- When pool is full, least recently used conversation is evicted (context restored via `--resume`)

### Worker Pool Management

```
thread_A msg 1 → worker-0 (newly assigned)
thread_A msg 2 → worker-0 (reused, context continues)
thread_B msg 1 → worker-1 (idle worker assigned)
...pool full...
thread_C arrives → evict oldest → kill → restart with --resume → serve thread_C
thread_A returns → evict oldest → restart with --resume session_A → context restored
```

### Access Control

| Setting | Description |
|---------|-------------|
| `dmPolicy: "open"` | Anyone can DM the bot |
| `dmPolicy: "pairing"` | Requires pairing code |
| `dmPolicy: "disabled"` | DM disabled |
| `groupAutoReply: ["oc_xxx"]` | These groups reply without @mention |

### Remote MCPs

Each Worker automatically loads all connected remote MCPs:
Clay, Gmail, Google Calendar, Context7, and all MCPs connected in Claude Desktop.

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `pool.maxWorkers` | 10 | Number of workers |
| `pool.basePort` | 7100 | Worker port range start |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API port |
| `lark.domain` | "lark" | "lark" or "lark" |
| `log.level` | "info" | Log level |

## Stop

```bash
# Ctrl+C in daemon terminal, or:
bun run src/index.ts stop
```

## Troubleshooting

<details>
<summary>Messages not getting replies</summary>

```bash
bun run src/index.ts status
curl http://localhost:7100/health
ps aux | grep "lark-mcp\|bun.*server" | grep -v grep
tail -50 ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log
```
</details>

<details>
<summary>Worker startup failure</summary>

```bash
tmux attach -t lark-worker-0
# Manual test:
LARK_DISPATCHER_PORT=7100 LARK_DAEMON_PORT=8900 claude \
  --dangerously-load-development-channels plugin:lark-customized@local-channels \
  --dangerously-skip-permissions
```
</details>

<details>
<summary>Port in use</summary>

```bash
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```
</details>

## Code Structure

| File | Responsibility |
|------|---------------|
| `src/daemon.ts` | Daemon entry, HTTP server, signal handling |
| `src/pool.ts` | Worker Pool: tmux management, assignment, eviction, resume |
| `src/router.ts` | Message routing: convKey, Mutex queuing, slash commands |
| `src/gateways/lark/ws.ts` | Lark WebSocket + event handling |
| `src/gateways/lark/receiver.ts` | Message parsing + dedup + access control |
| `src/gateways/lark/api.ts` | Lark HTTP API (messages, reactions) |
| `plugin/server.ts` | Channel plugin: localhost HTTP + MCP notification bridge |

## License

MIT
