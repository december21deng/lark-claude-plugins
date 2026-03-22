# Feishu Dispatcher

A hybrid dispatching system for Feishu (Lark) × Claude Code. Chat with Claude Code through Feishu with multi-session parallelism, context isolation, and full remote MCP support (Clay, Gmail, Calendar, etc.).

## Architecture

```
Feishu → Daemon (single WebSocket) → Router → Worker Pool (N Claude CLIs)
                                                    ↑ each has full remote MCPs
```

- **Daemon** holds the single Feishu WebSocket connection, receives all messages
- **Worker Pool** consists of N Claude CLI processes running in tmux sessions
- Each Worker is a full Claude CLI main process, automatically loading all remote MCPs
- Different conversations (threads) are assigned to different Workers with complete context isolation
- On eviction: kill + `--resume` rebuilds context losslessly

## Why This Architecture?

Claude Code's remote MCPs (Clay, Gmail, Calendar, etc.) are `type: "sdk"` — only available when Claude CLI runs as the **main process**. Subprocess approaches (like NeoClaw's `--input-format stream-json`) cannot load these MCPs.

However, when each Claude CLI connects its own Feishu WebSocket, Feishu only delivers messages to one connection. The solution: a daemon holds the single WebSocket and routes messages to Workers via localhost HTTP.

```
                                     ┌→ Claude CLI Worker 1 :7100 (all MCPs)
Feishu → Daemon (single WS) ────────┼→ Claude CLI Worker 2 :7101 (all MCPs)
                                     └→ Claude CLI Worker N :710N (all MCPs)
```

## Prerequisites

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) installed
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- Feishu/Lark self-built app (WebSocket mode)

## Quick Start

### 1. Install

```bash
cd ~/feishu-dispatcher
bash install.sh
```

### 2. Configure Feishu App

Create a self-built app on [Feishu Open Platform](https://open.feishu.cn):

1. Create app → get App ID and App Secret
2. Add capability → Bot
3. Permissions → enable `im:message`, `im:message:send_as_bot`, `im:resource`, `im:message.group_msg:readonly`
4. Events & Callbacks → choose **Long Connection (WebSocket)** mode
5. Subscribe event → `im.message.receive_v1`

### 3. Edit Configuration

```bash
vim ~/.feishu-dispatcher/config.json
```

```json
{
  "feishu": {
    "appId": "cli_your_app_id",
    "appSecret": "your_app_secret",
    "domain": "feishu",
    "access": {
      "dmPolicy": "open",
      "allowFrom": [],
      "groups": {},
      "groupAutoReply": ["oc_your_group_chat_id"]
    }
  },
  "pool": {
    "maxWorkers": 10,
    "basePort": 7100,
    "daemonApiPort": 8900
  },
  "claude": {
    "bin": "/Users/your_username/.local/bin/claude",
    "pluginChannel": "plugin:feishu-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "/Users/your_username/.feishu-dispatcher/logs"
  }
}
```

### 4. Start

```bash
cd ~/feishu-dispatcher && bun run src/index.ts start
```

The daemon will automatically:
1. Pre-trust the workspace directory
2. Create N tmux worker sessions
3. Auto-confirm all startup prompts
4. Connect Feishu WebSocket
5. Start receiving messages (as soon as the first worker is ready)

### 5. Verify

```bash
# Check status
bun run src/index.ts status

# List workers
tmux ls

# Attach to a worker terminal
tmux attach -t fd-worker-0
# (Ctrl+B D to detach)

# View logs
tail -f ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log
```

Send a message to the bot in Feishu — you should receive a reply.

## Usage

### Feishu Commands

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
- Up to N parallel conversations (configure `maxWorkers` in config)
- When pool is full, the least recently used conversation is evicted (context restored via `--resume`)

### Access Control

Configure in `config.json` under `access`:

| Setting | Description |
|---------|-------------|
| `dmPolicy: "open"` | Anyone can DM the bot |
| `dmPolicy: "pairing"` | Requires pairing code confirmation |
| `dmPolicy: "disabled"` | DM disabled |
| `groupAutoReply: ["oc_xxx"]` | These groups don't require @mention to reply |

### Remote MCPs

Each Worker is a Claude CLI main process, automatically loading all connected remote MCPs:

- Clay (company intelligence)
- Gmail (email)
- Google Calendar (scheduling)
- Context7 (documentation)
- All MCPs connected in Claude Desktop

## Stop

```bash
# Option 1: Ctrl+C (in daemon terminal)
# Option 2: command
cd ~/feishu-dispatcher && bun run src/index.ts stop
```

Automatically saves all session IDs and cleans up tmux sessions.

## Worker Pool Management

### How Workers Are Managed

```
thread_A message 1 → worker-0 (newly assigned)
thread_A message 2 → worker-0 (reused, context continues)
thread_B message 1 → worker-1 (idle worker assigned)
...pool full...
thread_C arrives   → evict oldest → kill worker → restart with --resume → serve thread_C
thread_A returns   → evict oldest → restart with --resume session_A → context restored
```

### Session Persistence

- Each conversation's Claude session ID is saved to `~/.feishu-dispatcher/sessions.json`
- On eviction + restart, `--resume <sessionId>` restores full conversation history
- On daemon restart, all session IDs are preserved
- No context mixing between conversations

### Health Checks

- Workers are health-checked via `localhost:PORT/health` before message forwarding
- Unhealthy workers are automatically restarted (up to 3 retries)
- Daemon captures tmux terminal output for diagnostics on failure

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `pool.maxWorkers` | 10 | Number of workers |
| `pool.basePort` | 7100 | Worker port range start |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API port |
| `feishu.domain` | "feishu" | "feishu" or "lark" |
| `log.level` | "info" | Log level |

## Troubleshooting

### Messages not getting replies
```bash
# 1. Check daemon is running
bun run src/index.ts status

# 2. Check worker health
curl http://localhost:7100/health

# 3. Check for competing Feishu WebSocket connections
ps aux | grep "lark-mcp\|bun.*server" | grep -v grep

# 4. View logs
tail -50 ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log
```

### Worker startup failure
```bash
# View worker terminal
tmux attach -t fd-worker-0

# Manual startup test
FEISHU_DISPATCHER_PORT=7100 FEISHU_DAEMON_PORT=8900 claude --dangerously-load-development-channels plugin:feishu-customized@local-channels --dangerously-skip-permissions
```

### Port in use
```bash
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```

## Development

### Code Structure

| File | Responsibility |
|------|---------------|
| `src/daemon.ts` | Daemon entry, HTTP server, signal handling |
| `src/pool.ts` | Worker Pool: tmux management, assignment, eviction, resume |
| `src/router.ts` | Message routing: convKey computation, Mutex queuing, slash commands |
| `src/gateways/feishu/ws.ts` | Feishu WebSocket connection + event handling |
| `src/gateways/feishu/receiver.ts` | Message parsing + dedup + gate access control |
| `src/gateways/feishu/api.ts` | Feishu HTTP API (send messages, reactions) |
| `plugin/server.ts` | Channel plugin: localhost HTTP + MCP notification bridge |

### Design Document

See [DESIGN.md](./DESIGN.md)

## License

MIT
