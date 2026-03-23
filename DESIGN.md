# IM x Claude Code Hybrid Dispatch System -- Design Document

## 1. Background and Goals

### 1.1 Problem

Interacting with Claude Code through IM (Lark/Feishu, Discord, etc.) requires satisfying all of the following simultaneously:
1. **Remote MCPs** -- Cloud MCPs like Clay, Gmail, Calendar are only available when Claude CLI runs as the main process
2. **Multi-session parallelism** -- Multiple conversations (threads) processed concurrently without blocking each other
3. **Context isolation** -- Each thread has its own conversation context, no cross-contamination
4. **Session management** -- Context persistence, resume, recovery after eviction
5. **Multi-platform** -- Support Lark and Discord (v2 extension)
6. **Permission forwarding** -- Forward Claude's permission prompts to IM (v2, implemented)
7. **Emoji state machine** -- Multi-stage emoji feedback for message processing lifecycle (v3, implemented)

### 1.2 Constraints
- Remote MCPs are `type: "sdk"`, injected by Claude Desktop, **only available when Claude CLI is the main process**
- NeoClaw/OpenClaw subprocess mode (`--input-format stream-json`) cannot load remote MCPs
- Channel plugins (`--channels`) each connect independently to IM WebSocket; IM only delivers to one
- Custom plugins must be loaded via `--dangerously-load-development-channels`
- Claude CLI requires an interactive terminal (TTY), solved via **tmux**

### 1.3 Approach Evaluation

| Approach | Remote MCPs | Multi-session | Conclusion |
|----------|------------|---------------|------------|
| NeoClaw (subprocess) | No | Yes | Cannot load remote MCPs |
| OpenClaw (subprocess) | No | Yes | Same |
| Single CLI + Channel plugin | Yes | No | Single session only |
| **Daemon + tmux Worker Pool** | **Yes** | **Yes** | **This design** |

### 1.4 Final Architecture

```
Lark Cloud
    | (WebSocket, single connection)
    v
+--------------------------------------+
|  Lark Dispatcher Daemon              |
|                                      |
|  +- Gateway ----------------------+  |
|  | lark-gw (WebSocket + API)      |  |
|  +------------+-------------------+  |
|               |                      |
|  +- Core -----v------------------+   |
|  | Router (convKey + Mutex queue) |   |
|  | Worker Pool (tmux mgmt)       |   |
|  | Session Store (persistence)   |   |
|  | Permission (card forwarding)  |   |
|  | Reaction Tracker (emoji state)|   |
|  | Admin Manager (group/admin)   |   |
|  +------------+------------------+   |
|               |                      |
|  +- API ------v------------------+   |
|  | HTTP :8900 (tool-call recv)   |   |
|  | Lark API (messages/reactions) |   |
|  +-------------------------------+   |
+--------------+-----------------------+
               | localhost HTTP (per-port)
         +-----+---------- ... --+
         v     v                 v
      +------++------+       +------+
      |CLI-0 ||CLI-1 |  ...  |CLI-9 |  10 tmux workers
      |:7100 ||:7101 |       |:7109 |  each with full remote MCPs
      |+Clay ||+Gmail|       |+Cal  |
      +------++------+       +------+
```

## 2. Core Concepts

### 2.1 convKey (Conversation Identifier)

Each independent conversation has a unique convKey, format: `{platform}:{chatId}[_thread_{threadId}]`

| Scenario | convKey Example |
|----------|----------------|
| Lark DM | `lark:oc_abc123` |
| Lark group (no topic) | `lark:oc_def456` |
| Lark topic thread | `lark:oc_def456_thread_omt_789` |

### 2.2 Worker Pool (tmux Management)

**Fixed N Claude CLI workers**, each running in its own tmux session:

- Daemon creates N tmux sessions on startup (`lark-worker-0` through `lark-worker-N`)
- Each session runs `claude --dangerously-load-development-channels --dangerously-skip-permissions`
- Auto-confirms development channels prompt via `tmux send-keys Enter`
- Trust prompt resolved via `claude -p` to pre-trust the directory (one-time)

### 2.3 Context Isolation Guarantee

**Different threads never have their contexts mixed**, because:

1. Each convKey has its own `sessionId` (UUID), stored in `sessions.json`
2. On eviction: **kill tmux session -> create new tmux session -> `--resume <sessionId>`**
3. There is no "same process switching context" -- each time is a fresh process

```
sessions.json:
{
  "lark:oc_abc_thread_A": "session-uuid-111",
  "lark:oc_abc_thread_B": "session-uuid-222",
  "lark:oc_abc_thread_C": "session-uuid-333"
}
```

### 2.4 Worker Lifecycle

```
Daemon startup
  -> Create 10 tmux sessions, each running Claude CLI
  -> Auto-confirm development channels prompt
  -> Mark ready after health check passes

Message arrives
  -> Compute convKey
  -> Already assigned worker -> health check -> healthy = reuse, unhealthy = restart
  -> No assignment -> find idle worker -> assign
  -> Pool full -> evict LRU -> kill tmux -> rebuild --resume -> assign

Eviction
  -> Save evicted conversation's sessionId
  -> Kill tmux session
  -> Create new tmux session (with new conversation's --resume)

Evicted conversation returns
  -> Evict LRU again
  -> --resume restores full context

Daemon shutdown
  -> Save all sessionIds
  -> Kill all tmux sessions
```

### 2.5 Emoji Reactions (v3 State Machine)

| Timing | Emoji | Behavior |
|--------|-------|----------|
| Message received | `Typing` | Add (keyboard animation) |
| Worker assigned | `OnIt` | Replace Typing |
| Reply sent | `DONE` | Replace OnIt (permanent) |
| Error | `FACEPALM` | Replace current (permanent) |

All emoji types from openclaw-lark `VALID_FEISHU_EMOJI_TYPES`.
Batch processing: multiple pending messages all get DONE on reply.
No TTL sweep -- lifecycle-driven cleanup only.

## 3. Project Structure

```
lark-claude-plugins/
├── plugin-standalone/               # Standalone: direct Lark WebSocket
│   ├── server.ts
│   ├── package.json
│   └── .claude-plugin/plugin.json
│
├── plugin-dispatcher/               # Dispatcher: localhost HTTP bridge
│   ├── server.ts
│   ├── package.json
│   └── .claude-plugin/plugin.json
│
├── dispatcher/                      # Daemon with worker pool
│   ├── src/
│   │   ├── index.ts                 # Entry: start/stop/status
│   │   ├── daemon.ts                # HTTP server + gateway startup + signal handling
│   │   ├── pool.ts                  # Worker Pool: tmux mgmt + assignment + eviction + resume
│   │   ├── router.ts                # Message routing: convKey + Mutex queue + slash commands
│   │   ├── permission.ts            # Permission forwarding: interactive card with Allow/Deny
│   │   ├── reaction-tracker.ts      # Emoji state machine: lifecycle-driven reactions
│   │   ├── admin.ts                 # Admin management: group/admin CRUD
│   │   ├── session-store.ts         # Session persistence
│   │   ├── config.ts                # Config loading
│   │   ├── types.ts                 # Shared types
│   │   ├── gateways/
│   │   │   ├── types.ts
│   │   │   └── lark/
│   │   │       ├── ws.ts            # Lark WebSocket + event handling
│   │   │       ├── receiver.ts      # Message parsing + dedup + gate
│   │   │       └── api.ts           # Lark HTTP API
│   │   └── utils/
│   │       ├── mutex.ts
│   │       ├── dedup.ts
│   │       ├── debounced-flush.ts
│   │       └── logger.ts
│   └── tests/                       # 117 unit tests
│       ├── mutex.test.ts
│       ├── dedup.test.ts
│       ├── router.test.ts
│       ├── session-store.test.ts
│       ├── receiver.test.ts
│       ├── reaction-tracker.test.ts
│       ├── admin.test.ts
│       ├── emoji-resolve.test.ts
│       └── reply-threading.test.ts
│
├── README.md                        # English (default)
├── README_CN.md                     # Chinese
├── DESIGN.md                        # This file (English)
├── DESIGN_CN.md                     # Chinese design doc
├── CLAUDE.md                        # Dev guidelines
├── config.example.json
└── install.sh
```

**Runtime data** `~/.lark-dispatcher/`:
```
~/.lark-dispatcher/
├── config.json
├── sessions.json
├── admins.json      (managed by AdminManager)
├── groups.json      (managed by AdminManager)
├── daemon.pid
└── logs/
```

**Plugin registration**:
```
~/.claude/plugins/
├── marketplaces/local-channels/
│   ├── marketplace.json
│   └── external_plugins/lark-customized/ -> ~/lark-dispatcher/plugin/
└── cache/local-channels/lark-customized/0.0.1/ -> ~/lark-dispatcher/plugin/
```

## 4. Data Flows

### 4.1 Complete Request Lifecycle

```
+- User sends message in Lark -----------------------------------------+
|                                                                       |
|  1. lark-gw: receive im.message.receive_v1                           |
|  2. receiver: parse + dedup + gate access check                      |
|  3. lark-gw: add Typing reaction                                    |
|  4. router: compute convKey, acquire Mutex                           |
|  5. pool: getWorker(convKey)                                         |
|     |- assigned worker -> health check -> healthy = reuse            |
|     |- idle worker -> health check -> healthy = assign               |
|     |- unhealthy worker -> kill tmux -> rebuild -> assign            |
|     +- pool full -> evict LRU -> kill tmux -> rebuild --resume       |
|  5b. router: transition emoji to OnIt                                |
|  6. router: POST localhost:{worker.port}/message                     |
|                                                                       |
|  --- Enter Claude CLI (tmux session) ---                              |
|                                                                       |
|  7. plugin: receive message -> mcp.notification -> Claude processes  |
|  8. Claude calls tools (all remote MCPs: Clay, Gmail, Calendar...)   |
|  9. Claude calls reply tool                                          |
|  10. plugin: POST localhost:8900/tool-call                           |
|                                                                       |
|  --- Back to Daemon ---                                               |
|                                                                       |
|  11. daemon: receive tool-call, execute Lark API to send message     |
|  12. daemon: batch transition all pending messages to DONE           |
|  13. router: release Mutex                                           |
|                                                                       |
|  --- User receives reply in Lark ---                                  |
+-----------------------------------------------------------------------+
```

### 4.2 Permission Forwarding Flow (v2)

```
+- Claude needs permission ------------------------------------------------+
|                                                                          |
|  1. plugin: Claude triggers a permission prompt                          |
|  2. plugin: POST localhost:8900/permission-request                       |
|                                                                          |
|  --- Daemon handles ---                                                  |
|                                                                          |
|  3. permission.ts: Build interactive card with Allow/Deny buttons        |
|  4. permission.ts: Send card to user in Lark                             |
|  5. User clicks Allow or Deny (card.action.trigger_v1)                   |
|     OR user replies with text ("允许"/"拒绝")                              |
|  6. permission.ts: Forward decision back to plugin                       |
|  7. plugin: Resume Claude with the user's decision                       |
|                                                                          |
|  Timeout: 2 minutes -> auto-deny                                        |
+--------------------------------------------------------------------------+
```

### 4.3 Admin Management Flow (v3)

```
Admin sends DM to bot (natural language, e.g. "add snow to sales group")
→ Normal routing to Claude worker
→ Claude understands intent, calls manage_access tool
→ Plugin proxies to daemon /tool-call
→ Daemon checks sender permission (superadmin/admin)
→ AdminManager executes action, persists to groups.json/admins.json
→ Returns result to Claude → Claude replies to admin
```

### 4.4 Worker Assignment and Eviction Example

```
10 workers, 12 threads scenario:

10:00  thread_A -> worker-0 (new session)
10:01  thread_B -> worker-1 (new session)
 ...
10:09  thread_J -> worker-9 (new session)

10:10  thread_K arrives, pool full!
       -> thread_A is LRU (10:00)
       -> save sessions["thread_A"] = "session-aaa"
       -> kill tmux lark-worker-0
       -> create lark-worker-0, no --resume (new conversation)
       -> thread_K assigned to worker-0

10:30  thread_A comes back
       -> thread_B is LRU (10:01)
       -> save sessions["thread_B"] = "session-bbb"
       -> kill tmux lark-worker-1
       -> create lark-worker-1 --resume session-aaa
       -> thread_A full context restored!
```

## 5. Configuration

`~/.lark-dispatcher/config.json`:
```json
{
  "lark": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "domain": "feishu",
    "superadmins": ["ou_xxx_janice"],
    "access": {
      "dmPolicy": "open",
      "allowFrom": [],
      "groups": {},
      "groupAutoReply": ["oc_xxx"]
    }
  },
  "pool": {
    "maxWorkers": 10,
    "basePort": 7100,
    "daemonApiPort": 8900
  },
  "claude": {
    "bin": "/usr/local/bin/claude",
    "pluginChannel": "plugin:lark-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "~/.lark-dispatcher/logs"
  }
}
```

## 6. Startup

```bash
# One-command start (auto-creates 10 tmux workers + Lark connection)
cd dispatcher && bun run src/index.ts start

# Check status
bun run src/index.ts status

# View worker terminals
tmux ls                          # List all workers
tmux attach -t lark-worker-0    # View a worker

# Stop
bun run src/index.ts stop
# or Ctrl+C
```

## 7. Implementation Phases

### Phase 1: Core -- Complete
- [x] Channel plugin dispatcher mode (localhost HTTP + tool proxy)
- [x] Daemon: Lark WebSocket + message parsing + access control
- [x] Worker Pool: tmux management + auto-confirm + health check
- [x] Router: convKey routing + Mutex queuing + slash commands
- [x] Session persistence + resume
- [x] Emoji: Typing reaction (OpenClaw style)
- [x] Eviction: kill tmux + rebuild --resume (context isolation)

### Phase 2: Permission + Standalone -- Complete
- [x] Permission forwarding to Lark interactive cards (Allow/Deny buttons, text fallback)
- [x] Plugin standalone mode (direct WebSocket without daemon)

### Phase 3: v3 Features -- Complete
- [x] Emoji state machine (Typing → OnIt → DONE/FACEPALM lifecycle)
- [x] Admin management (natural language group/admin CRUD via Claude)
- [x] Session persistence improvements
- [x] Card fix and mention resolution

### Phase 4: Testing -- Complete
- [x] 117 unit tests across 9 files (mutex, dedup, router, session-store, receiver, reaction-tracker, admin, emoji-resolve, reply-threading)
- [x] All tests passing (`cd dispatcher && bun test`)

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Worker startup slow (~10s each) | Parallel startup + Typing reaction to signal processing |
| tmux session crashes | getWorker does health check, auto-restarts unhealthy workers |
| Slow --resume on eviction | Typing reaction + async processing |
| Lark WebSocket disconnect | Lark SDK built-in reconnection |
| sessions.json corruption | try-catch + empty map fallback |
| 10 workers memory usage | Claude CLI idle: CPU=0, ~200MB/worker |
| Permission card timeout | 2-minute deadline, auto-deny on expiration |
| Unattended worker blocked by interactive confirm | System prompt forbids interactive operations |
