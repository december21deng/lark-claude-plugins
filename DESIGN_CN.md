# IM × Claude Code 混合调度系统设计方案

## 1. 背景与目标

### 1.1 问题
通过 IM（飞书、Discord 等）与 Claude Code 交互，需同时满足：
1. **远程 MCP** — Clay、Gmail、Calendar 等云端 MCP 只在 Claude CLI 作为主进程时可用
2. **多会话并行** — 多个对话（thread）同时处理，不互相阻塞
3. **上下文隔离** — 每个 thread 有独立的对话上下文，不会混淆
4. **会话管理** — 上下文持久化、resume、被驱逐后恢复
5. **多平台** — 同时接入飞书和 Discord（v2 扩展）
6. **Permission 转发** — 将 Claude 的权限确认转发到 IM（v2）
7. **流式卡片** — 在 IM 中实时显示进度（v2）

### 1.2 约束
- 远程 MCP 是 `type: "sdk"`，由 Claude Desktop 注入，**只有 Claude CLI 作为主进程时才有**
- NeoClaw/OpenClaw 子进程模式（`--input-format stream-json`）无法加载远程 MCP
- Channel 插件（`--channels`）每个 CLI 实例独立连 IM WebSocket，IM 只推给一个
- 自定义插件必须用 `--dangerously-load-development-channels` 加载
- Claude CLI 需要交互式终端（TTY），通过 **tmux** 解决

### 1.3 方案调研结论

| 方案 | 远程 MCP | 多会话 | 结论 |
|------|---------|--------|------|
| NeoClaw（子进程） | ❌ | ✅ | 无法加载远程 MCP |
| OpenClaw（子进程） | ❌ | ✅ | 同上 |
| 单 CLI + Channel 插件 | ✅ | ❌ | 只能单会话 |
| **Daemon + tmux Worker Pool** | **✅** | **✅** | **本方案** |

### 1.4 最终架构

```
飞书云端
    │ (WebSocket, 唯一连接)
    ▼
┌──────────────────────────────────────┐
│  Feishu Dispatcher Daemon            │
│                                      │
│  ┌─ Gateway ──────────────────────┐  │
│  │ feishu-gw (WebSocket + API)    │  │
│  └────────────┬───────────────────┘  │
│               │                      │
│  ┌─ Core ─────▼──────────────────┐   │
│  │ Router (convKey + Mutex 排队)  │   │
│  │ Worker Pool (tmux 管理)        │   │
│  │ Session Store (持久化)         │   │
│  └────────────┬──────────────────┘   │
│               │                      │
│  ┌─ API ──────▼──────────────────┐   │
│  │ HTTP :8900 (接收 tool-call)   │   │
│  │ 飞书 API (发消息/表情)         │   │
│  └───────────────────────────────┘   │
└──────────────┬───────────────────────┘
               │ localhost HTTP (per-port)
         ┌─────┼────────── ··· ──┐
         ▼     ▼                 ▼
      ┌──────┐┌──────┐       ┌──────┐
      │CLI-0 ││CLI-1 │  ···  │CLI-9 │  10 个 tmux worker
      │:7100 ││:7101 │       │:7109 │  每个有完整远程 MCP
      │+Clay ││+Gmail│       │+Cal  │
      └──────┘└──────┘       └──────┘
```

## 2. 核心概念

### 2.1 convKey（对话标识符）

每个独立对话有唯一的 convKey，格式：`{platform}:{chatId}[_thread_{threadId}]`

| 场景 | convKey 示例 |
|------|-------------|
| 飞书私聊 | `feishu:oc_abc123` |
| 飞书群聊（不分话题） | `feishu:oc_def456` |
| 飞书子话题 | `feishu:oc_def456_thread_omt_789` |

### 2.2 Worker Pool（tmux 管理）

**固定 N 个 Claude CLI worker**，每个运行在独立的 tmux session 中：

- Daemon 启动时自动创建 N 个 tmux session（`fd-worker-0` 到 `fd-worker-N`）
- 每个 session 运行 `claude --dangerously-load-development-channels --dangerously-skip-permissions`
- 通过 `tmux send-keys Enter` 自动确认 development channels 提示
- Trust 提示通过 `claude -p` 预信任目录，只需一次

### 2.3 上下文隔离保证

**不同 thread 的上下文绝不会混淆**，因为：

1. 每个 convKey 有独立的 `sessionId`（UUID），存在 `sessions.json`
2. 驱逐时：**kill tmux session → 新建 tmux session → `--resume <sessionId>`**
3. 不存在"同一个进程切换上下文"——每次都是全新进程

```
sessions.json:
{
  "feishu:oc_abc_thread_A": "session-uuid-111",
  "feishu:oc_abc_thread_B": "session-uuid-222",
  "feishu:oc_abc_thread_C": "session-uuid-333"
}
```

### 2.4 Worker 生命周期

```
Daemon 启动
  → 创建 10 个 tmux session，每个运行 Claude CLI
  → 自动确认 development channels 提示
  → health check 通过后标记 ready

消息到达
  → 计算 convKey
  → 已分配 worker → health check → 健康则复用，不健康则重启
  → 无分配 → 找空闲 worker → 分配
  → 池满 → 驱逐最久未用 → kill tmux → 新建 tmux --resume → 分配

驱逐
  → 保存被驱逐对话的 sessionId
  → kill tmux session
  → 创建新 tmux session（带新对话的 --resume）

被驱逐对话回来
  → 再次驱逐最久未用
  → --resume 恢复完整上下文

Daemon 关闭
  → 保存所有 sessionId
  → kill 所有 tmux session
```

### 2.5 Emoji 反应（对齐 OpenClaw）

| 时机 | Emoji | 行为 |
|------|-------|------|
| 收到消息 | `Typing` ⌨️ | 添加（键盘动画，表示处理中） |
| 回复成功 | - | 移除 `Typing` |
| 错误 | - | 移除 `Typing`（静默） |
| 加/移除失败 | - | 静默忽略，不影响主流程 |

## 3. 项目结构

```
~/feishu-dispatcher/
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── index.ts                       # 入口：start/stop/status
│   ├── daemon.ts                      # HTTP server + gateway 启动 + 信号处理
│   ├── pool.ts                        # Worker Pool：tmux 管理 + 分配 + 驱逐 + resume
│   ├── router.ts                      # 消息路由：convKey + Mutex 排队 + 斜杠命令
│   ├── session-store.ts               # Session 持久化
│   ├── config.ts                      # 配置加载
│   ├── types.ts                       # 共享类型
│   ├── gateways/
│   │   ├── types.ts
│   │   └── feishu/
│   │       ├── ws.ts                  # 飞书 WebSocket + 事件处理
│   │       ├── receiver.ts            # 消息解析 + 去重 + gate
│   │       └── api.ts                 # 飞书 HTTP API
│   └── utils/
│       ├── mutex.ts
│       ├── dedup.ts
│       ├── debounced-flush.ts
│       └── logger.ts
│
├── plugin/                            # Channel 插件（每个 worker 加载）
│   ├── server.ts                      # MCP server：调度模式（localhost HTTP）
│   ├── package.json
│   ├── .mcp.json
│   └── .claude-plugin/plugin.json
│
└── install.sh
```

**运行时数据** `~/.feishu-dispatcher/`：
```
~/.feishu-dispatcher/
├── config.json
├── sessions.json
├── daemon.pid
└── logs/
```

**插件注册**：
```
~/.claude/plugins/
├── marketplaces/local-channels/
│   ├── marketplace.json
│   └── external_plugins/feishu-customized/ → ~/feishu-dispatcher/plugin/
└── cache/local-channels/feishu-customized/0.0.1/ → ~/feishu-dispatcher/plugin/
```

## 4. 数据流

### 4.1 完整请求生命周期

```
┌─ 飞书用户发消息 ─────────────────────────────────────────────────┐
│                                                                  │
│  1. feishu-gw: 接收 im.message.receive_v1                        │
│  2. receiver: 解析 + 去重 + gate 权限检查                         │
│  3. feishu-gw: 添加 Typing ⌨️ 反应                               │
│  4. router: 计算 convKey，acquire Mutex                          │
│  5. pool: getWorker(convKey)                                     │
│     ├─ 有已分配 worker → health check → 健康则复用               │
│     ├─ 有空闲 worker → health check → 健康则分配                 │
│     ├─ worker 不健康 → kill tmux → 重建 → 分配                   │
│     └─ 池满 → 驱逐最久未用 → kill tmux → 重建 --resume → 分配    │
│  6. router: POST localhost:{worker.port}/message                 │
│                                                                  │
│  ─── 进入 Claude CLI（tmux session）───                           │
│                                                                  │
│  7. plugin: 收到消息 → mcp.notification → Claude 处理             │
│  8. Claude 调用工具（可用所有远程 MCP：Clay, Gmail, Calendar...）  │
│  9. Claude 调用 reply tool                                        │
│  10. plugin: POST localhost:8900/tool-call                        │
│                                                                  │
│  ─── 回到 Daemon ───                                              │
│                                                                  │
│  11. daemon: 收到 tool-call，执行飞书 API 发消息                  │
│  12. daemon: 移除 Typing ⌨️ 反应                                  │
│  13. router: release Mutex                                        │
│                                                                  │
│  ─── 用户在飞书收到回复 ───                                        │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Worker 分配与驱逐示例

```
10 个 worker，12 个 thread 的场景：

10:00  thread_A → worker-0 (新 session)
10:01  thread_B → worker-1 (新 session)
 ...
10:09  thread_J → worker-9 (新 session)

10:10  thread_K 来了，池满！
       → thread_A 最久没用(10:00)
       → 保存 sessions["thread_A"] = "session-aaa"
       → kill tmux fd-worker-0
       → 新建 fd-worker-0，无 --resume（新对话）
       → thread_K 分配到 worker-0

10:30  thread_A 回来了
       → thread_B 最久没用(10:01)
       → 保存 sessions["thread_B"] = "session-bbb"
       → kill tmux fd-worker-1
       → 新建 fd-worker-1 --resume session-aaa
       → thread_A 恢复完整上下文！
```

## 5. 配置

`~/.feishu-dispatcher/config.json`:
```json
{
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "domain": "feishu",
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
    "bin": "/Users/mangliu/.local/bin/claude",
    "pluginChannel": "plugin:feishu-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "~/.feishu-dispatcher/logs"
  }
}
```

## 6. 启动方式

```bash
# 一键启动（自动创建 10 个 tmux worker + 飞书连接）
cd ~/feishu-dispatcher && bun run src/index.ts start

# 查看状态
bun run src/index.ts status

# 查看 worker 终端
tmux ls                        # 列出所有 worker
tmux attach -t fd-worker-0     # 查看某个 worker

# 停止
bun run src/index.ts stop
# 或 Ctrl+C
```

## 7. 实施阶段

### Phase 1: 核心可用 ✅ (已完成)
- [x] Channel 插件调度模式（localhost HTTP + tool 代理）
- [x] Daemon: 飞书 WebSocket + 消息解析 + 权限
- [x] Worker Pool: tmux 管理 + 自动确认 + health check
- [x] Router: convKey 路由 + Mutex 排队 + 斜杠命令
- [x] Session 持久化 + resume
- [x] Emoji: Typing 反应（对齐 OpenClaw）
- [x] 驱逐: kill tmux + 重建 --resume（上下文隔离）

### Phase 2: 流式 + 权限
- [ ] Plugin → daemon 流式事件推送
- [ ] 飞书流式卡片（复用 NeoClaw/OpenClaw 卡片代码）
- [ ] Permission 转发到飞书交互卡片
- [ ] Discord gateway

### Phase 3: 生产就绪
- [ ] Worker 健康检查 + crash 自动恢复
- [ ] 监控指标（进程数、响应时间、队列深度）
- [ ] 会话记忆/摘要
- [ ] Dashboard

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Worker 启动慢（~10s/个） | 并行启动 + Typing 反应让用户知道在处理 |
| tmux session 意外退出 | getWorker 做 health check，不健康自动重启 |
| 驱逐时 --resume 恢复慢 | Typing 反应 + 异步处理 |
| 飞书 WS 断连 | Lark SDK 内建重连 |
| sessions.json 损坏 | try-catch + 空 map 降级 |
| 10 个 worker 内存占用 | Claude CLI 空闲时 CPU=0，内存约 200MB/个 |
