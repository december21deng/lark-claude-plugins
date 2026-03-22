# IM x Claude Code 混合调度系统设计方案

## 1. 背景与目标

### 1.1 问题
通过 IM（飞书、Discord 等）与 Claude Code 交互，需同时满足：
1. **远程 MCP** -- Clay、Gmail、Calendar 等云端 MCP 只在 Claude CLI 作为主进程时可用
2. **多会话并行** -- 多个对话（thread）同时处理，不互相阻塞
3. **上下文隔离** -- 每个 thread 有独立的对话上下文，不会混淆
4. **会话管理** -- 上下文持久化、resume、被驱逐后恢复
5. **多平台** -- 同时接入飞书和 Discord（v2 扩展）
6. **Permission 转发** -- 将 Claude 的权限确认转发到 IM（v2，已实现）
7. **流式卡片** -- 在 IM 中实时显示进度（v2，已实现）

### 1.2 约束
- 远程 MCP 是 `type: "sdk"`，由 Claude Desktop 注入，**只有 Claude CLI 作为主进程时才有**
- NeoClaw/OpenClaw 子进程模式（`--input-format stream-json`）无法加载远程 MCP
- Channel 插件（`--channels`）每个 CLI 实例独立连 IM WebSocket，IM 只推给一个
- 自定义插件必须用 `--dangerously-load-development-channels` 加载
- Claude CLI 需要交互式终端（TTY），通过 **tmux** 解决

### 1.3 方案调研结论

| 方案 | 远程 MCP | 多会话 | 结论 |
|------|---------|--------|------|
| NeoClaw（子进程） | 否 | 是 | 无法加载远程 MCP |
| OpenClaw（子进程） | 否 | 是 | 同上 |
| 单 CLI + Channel 插件 | 是 | 否 | 只能单会话 |
| **Daemon + tmux Worker Pool** | **是** | **是** | **本方案** |

### 1.4 最终架构

```
飞书云端
    | (WebSocket, 唯一连接)
    v
+--------------------------------------+
|  Lark Dispatcher Daemon              |
|                                      |
|  +- Gateway ----------------------+  |
|  | lark-gw (WebSocket + API)      |  |
|  +------------+-------------------+  |
|               |                      |
|  +- Core -----v------------------+   |
|  | Router (convKey + Mutex 排队)  |   |
|  | Worker Pool (tmux 管理)        |   |
|  | Session Store (持久化)         |   |
|  | Permission (卡片转发)          |   |
|  | Streaming Card (CardKit API)   |   |
|  +------------+------------------+   |
|               |                      |
|  +- API ------v------------------+   |
|  | HTTP :8900 (接收 tool-call)   |   |
|  | 飞书 API (发消息/表情)         |   |
|  +-------------------------------+   |
+--------------+-----------------------+
               | localhost HTTP (per-port)
         +-----+---------- ... --+
         v     v                 v
      +------++------+       +------+
      |CLI-0 ||CLI-1 |  ...  |CLI-9 |  10 个 tmux worker
      |:7100 ||:7101 |       |:7109 |  每个有完整远程 MCP
      |+Clay ||+Gmail|       |+Cal  |
      +------++------+       +------+
```

## 2. 核心概念

### 2.1 convKey（对话标识符）

每个独立对话有唯一的 convKey，格式：`{platform}:{chatId}[_thread_{threadId}]`

| 场景 | convKey 示例 |
|------|-------------|
| 飞书/Lark 私聊 | `lark:oc_abc123` |
| 飞书/Lark 群聊（不分话题） | `lark:oc_def456` |
| 飞书/Lark 子话题 | `lark:oc_def456_thread_omt_789` |

### 2.2 Worker Pool（tmux 管理）

**固定 N 个 Claude CLI worker**，每个运行在独立的 tmux session 中：

- Daemon 启动时自动创建 N 个 tmux session（`lark-worker-0` 到 `lark-worker-N`）
- 每个 session 运行 `claude --dangerously-load-development-channels --dangerously-skip-permissions`
- 通过 `tmux send-keys Enter` 自动确认 development channels 提示
- Trust 提示通过 `claude -p` 预信任目录，只需一次

### 2.3 上下文隔离保证

**不同 thread 的上下文绝不会混淆**，因为：

1. 每个 convKey 有独立的 `sessionId`（UUID），存在 `sessions.json`
2. 驱逐时：**kill tmux session -> 新建 tmux session -> `--resume <sessionId>`**
3. 不存在"同一个进程切换上下文"——每次都是全新进程

```
sessions.json:
{
  "lark:oc_abc_thread_A": "session-uuid-111",
  "lark:oc_abc_thread_B": "session-uuid-222",
  "lark:oc_abc_thread_C": "session-uuid-333"
}
```

### 2.4 Worker 生命周期

```
Daemon 启动
  -> 创建 10 个 tmux session，每个运行 Claude CLI
  -> 自动确认 development channels 提示
  -> health check 通过后标记 ready

消息到达
  -> 计算 convKey
  -> 已分配 worker -> health check -> 健康则复用，不健康则重启
  -> 无分配 -> 找空闲 worker -> 分配
  -> 池满 -> 驱逐最久未用 -> kill tmux -> 新建 tmux --resume -> 分配

驱逐
  -> 保存被驱逐对话的 sessionId
  -> kill tmux session
  -> 创建新 tmux session（带新对话的 --resume）

被驱逐对话回来
  -> 再次驱逐最久未用
  -> --resume 恢复完整上下文

Daemon 关闭
  -> 保存所有 sessionId
  -> kill 所有 tmux session
```

### 2.5 Emoji 反应（OpenClaw 风格）

| 时机 | Emoji | 行为 |
|------|-------|------|
| 收到消息 | `Typing` | 添加（键盘动画，表示处理中） |
| 回复成功 | - | 移除 `Typing` |
| 错误 | - | 移除 `Typing`（静默） |
| 加/移除失败 | - | 静默忽略，不影响主流程 |

## 3. 项目结构

```
lark-claude-plugins/
├── plugin-standalone/               # 独立模式：直连飞书 WebSocket
│   ├── server.ts
│   ├── package.json
│   └── .claude-plugin/plugin.json
│
├── plugin-dispatcher/               # 调度模式：localhost HTTP 桥接
│   ├── server.ts
│   ├── package.json
│   └── .claude-plugin/plugin.json
│
├── dispatcher/                      # 带 worker pool 的 Daemon
│   ├── src/
│   │   ├── index.ts                 # 入口：start/stop/status
│   │   ├── daemon.ts                # HTTP server + gateway 启动 + 信号处理
│   │   ├── pool.ts                  # Worker Pool：tmux 管理 + 分配 + 驱逐 + resume
│   │   ├── router.ts                # 消息路由：convKey + Mutex 排队 + 斜杠命令
│   │   ├── permission.ts            # 权限转发：允许/拒绝交互卡片
│   │   ├── streaming-card.ts        # 流式卡片：CardKit API + 可折叠工具面板
│   │   ├── session-store.ts         # 会话持久化
│   │   ├── config.ts                # 配置加载
│   │   ├── types.ts                 # 共享类型
│   │   ├── gateways/
│   │   │   ├── types.ts
│   │   │   └── lark/
│   │   │       ├── ws.ts            # 飞书 WebSocket + 事件处理
│   │   │       ├── receiver.ts      # 消息解析 + 去重 + gate
│   │   │       └── api.ts           # 飞书 HTTP API
│   │   └── utils/
│   │       ├── mutex.ts
│   │       ├── dedup.ts
│   │       ├── debounced-flush.ts
│   │       └── logger.ts
│   └── tests/                       # 52 个单元测试
│       ├── mutex.test.ts
│       ├── dedup.test.ts
│       ├── router.test.ts
│       ├── session-store.test.ts
│       └── receiver.test.ts
│
├── README.md                        # 英文（默认）
├── README_CN.md                     # 中文
├── DESIGN.md                        # 英文设计文档
├── DESIGN_CN.md                     # 本文件（中文设计文档）
├── CLAUDE.md                        # 开发指南
├── config.example.json
└── install.sh
```

**运行时数据** `~/.lark-dispatcher/`：
```
~/.lark-dispatcher/
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
│   └── external_plugins/lark-customized/ -> ~/lark-dispatcher/plugin/
└── cache/local-channels/lark-customized/0.0.1/ -> ~/lark-dispatcher/plugin/
```

## 4. 数据流

### 4.1 完整请求生命周期

```
+- 飞书用户发消息 ---------------------------------------------------+
|                                                                     |
|  1. lark-gw: 接收 im.message.receive_v1                           |
|  2. receiver: 解析 + 去重 + gate 权限检查                            |
|  3. lark-gw: 添加 Typing 反应                                      |
|  4. router: 计算 convKey，acquire Mutex                             |
|  5. pool: getWorker(convKey)                                        |
|     |- 有已分配 worker -> health check -> 健康则复用                 |
|     |- 有空闲 worker -> health check -> 健康则分配                   |
|     |- worker 不健康 -> kill tmux -> 重建 -> 分配                    |
|     +- 池满 -> 驱逐最久未用 -> kill tmux -> 重建 --resume -> 分配    |
|  6. router: POST localhost:{worker.port}/message                    |
|                                                                     |
|  --- 进入 Claude CLI（tmux session）---                              |
|                                                                     |
|  7. plugin: 收到消息 -> mcp.notification -> Claude 处理              |
|  8. Claude 调用工具（可用所有远程 MCP：Clay, Gmail, Calendar...）    |
|  9. Claude 调用 reply tool                                          |
|  10. plugin: POST localhost:8900/tool-call                          |
|                                                                     |
|  --- 回到 Daemon ---                                                |
|                                                                     |
|  11. daemon: 收到 tool-call，执行飞书 API 发消息                    |
|  12. daemon: 移除 Typing 反应                                       |
|  13. router: release Mutex                                          |
|                                                                     |
|  --- 用户在飞书收到回复 ---                                          |
+---------------------------------------------------------------------+
```

### 4.2 权限转发流程（v2）

```
+- Claude 需要权限确认 ------------------------------------------------+
|                                                                       |
|  1. plugin: Claude 触发权限确认提示                                    |
|  2. plugin: POST localhost:8900/permission-request                    |
|                                                                       |
|  --- Daemon 处理 ---                                                  |
|                                                                       |
|  3. permission.ts: 构建带有允许/拒绝按钮的交互卡片                      |
|  4. permission.ts: 在飞书中向用户发送卡片                               |
|  5. 用户点击允许或拒绝（card.action.trigger_v1）                        |
|     或用户回复文本（"允许"/"拒绝"）                                     |
|  6. permission.ts: 将决定转发回 plugin                                 |
|  7. plugin: 以用户的决定恢复 Claude                                    |
|                                                                       |
|  超时：2 分钟 -> 自动拒绝                                              |
+-----------------------------------------------------------------------+
```

### 4.3 流式卡片流程（v2）

```
+- Claude 正在处理请求 -------------------------------------------------+
|                                                                        |
|  1. plugin: Claude 开始工作，发出 tool_use 事件                         |
|  2. plugin: POST localhost:8900/streaming-update                       |
|                                                                        |
|  --- Daemon 处理 ---                                                   |
|                                                                        |
|  3. streaming-card.ts: 通过 CardKit API 创建卡片                       |
|  4. streaming-card.ts: 用工具步骤更新卡片（可折叠面板）                   |
|  5. streaming-card.ts: 以打字机效果流式文本                              |
|  6. 最终回复时：自动定稿卡片                                            |
|                                                                        |
|  用户在飞书中看到实时进度：                                              |
|  +----------------------------------+                                  |
|  | [v] 工具调用步骤                  |                                  |
|  |   - search_web("query")          |                                  |
|  |   - read_file("/path/to/file")   |                                  |
|  |                                   |                                  |
|  | 根据分析结果，答案是...             |                                 |
|  +----------------------------------+                                  |
+------------------------------------------------------------------------+
```

### 4.4 Worker 分配与驱逐示例

```
10 个 worker，12 个 thread 的场景：

10:00  thread_A -> worker-0 (新 session)
10:01  thread_B -> worker-1 (新 session)
 ...
10:09  thread_J -> worker-9 (新 session)

10:10  thread_K 来了，池满！
       -> thread_A 最久没用(10:00)
       -> 保存 sessions["thread_A"] = "session-aaa"
       -> kill tmux lark-worker-0
       -> 新建 lark-worker-0，无 --resume（新对话）
       -> thread_K 分配到 worker-0

10:30  thread_A 回来了
       -> thread_B 最久没用(10:01)
       -> 保存 sessions["thread_B"] = "session-bbb"
       -> kill tmux lark-worker-1
       -> 新建 lark-worker-1 --resume session-aaa
       -> thread_A 恢复完整上下文！
```

## 5. 配置

`~/.lark-dispatcher/config.json`:
```json
{
  "lark": {
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
    "bin": "/usr/local/bin/claude",
    "pluginChannel": "plugin:lark-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "~/.lark-dispatcher/logs"
  }
}
```

## 6. 启动方式

```bash
# 一键启动（自动创建 10 个 tmux worker + 飞书连接）
cd dispatcher && bun run src/index.ts start

# 查看状态
bun run src/index.ts status

# 查看 worker 终端
tmux ls                          # 列出所有 worker
tmux attach -t lark-worker-0    # 查看某个 worker

# 停止
bun run src/index.ts stop
# 或 Ctrl+C
```

## 7. 实施阶段

### Phase 1: 核心可用 -- 已完成
- [x] Channel 插件调度模式（localhost HTTP + tool 代理）
- [x] Daemon: 飞书 WebSocket + 消息解析 + 权限
- [x] Worker Pool: tmux 管理 + 自动确认 + health check
- [x] Router: convKey 路由 + Mutex 排队 + 斜杠命令
- [x] Session 持久化 + resume
- [x] Emoji: Typing 反应（OpenClaw 风格）
- [x] 驱逐: kill tmux + 重建 --resume（上下文隔离）

### Phase 2: 流式 + 权限 -- 已完成
- [x] Plugin -> daemon 流式事件推送
- [x] 飞书流式卡片（CardKit API，可折叠工具面板，打字机文本）
- [x] Permission 转发到飞书交互卡片（允许/拒绝按钮，文本降级）
- [x] 插件独立模式（无需 daemon 直连 WebSocket）

### Phase 3: 测试 -- 已完成
- [x] 52 个单元测试（mutex、dedup、router、session-store、receiver）
- [x] 全部测试通过（`cd dispatcher && bun test`）

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Worker 启动慢（~10s/个） | 并行启动 + Typing 反应让用户知道在处理 |
| tmux session 意外退出 | getWorker 做 health check，不健康自动重启 |
| 驱逐时 --resume 恢复慢 | Typing 反应 + 异步处理 |
| 飞书 WS 断连 | Lark SDK 内建重连 |
| sessions.json 损坏 | try-catch + 空 map 降级 |
| 10 个 worker 内存占用 | Claude CLI 空闲时 CPU=0，内存约 200MB/个 |
| 权限卡片超时 | 2 分钟期限，超时自动拒绝 |
| 流式卡片 API 限流 | debounced flush，批量更新 |
