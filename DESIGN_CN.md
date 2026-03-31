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
7. **Emoji 状态机** -- 消息处理生命周期的多阶段 emoji 反馈（v3，已实现）

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
|  | Reaction Tracker (emoji 状态)  |   |
|  | Admin Manager (群组/管理员)    |   |
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

### 2.4 Worker 状态与活跃感知调度（v4）

每个 Worker 追踪其活动状态：

| 状态 | 条件 | 可驱逐 |
|------|------|--------|
| ACTIVE | `busy === true` — 正在处理消息 | **永不** |
| IDLE | `busy === false`，有 session | 是（LRU 顺序） |
| STALE | IDLE + 空闲超过 `staleTimeoutMs` | 是（最高优先） |
| EMPTY | `convKey === null` | 不适用（空槽位） |

**Busy 生命周期：**
```
router.route() 转发 /message 给 worker   → pool.markBusy(convKey)
daemon 收到 'reply' tool-call             → pool.markIdle(convKey)
daemon 收到 tool-call 报错               → pool.markIdle(convKey)
worker 发起任意 tool-call                 → 更新 lastActivityAt（心跳）
```

**驱逐优先级（v4 分级）：**
1. 找 STALE worker（空闲超过 staleTimeoutMs，STALE 中按 LRU 排序）
2. 找 IDLE worker（不忙，按 LRU 排序）
3. 所有 worker 均 ACTIVE → 池已耗尽，消息排队

**消息队列（池耗尽时）：**
- 消息推入 `_pendingQueue`（FIFO，最多 50 条）
- 通知用户："所有助手正忙，已加入队列"
- 任一 worker 变空闲（`markIdle`）时自动取出排队消息处理
- 队列溢出时丢弃最旧消息

### 2.5 Worker 生命周期

```
Daemon 启动
  -> 创建 N 个 tmux session，每个运行 Claude CLI
  -> 自动确认 development channels 提示
  -> health check 通过后标记 ready

消息到达
  -> 计算 convKey
  -> 已分配 worker -> health check -> 健康则复用，不健康则重启
  -> 无分配 -> 找空闲 worker -> 分配
  -> 池满 -> 分级驱逐：
     1. 驱逐 STALE（空闲超时）
     2. 驱逐 IDLE（LRU）
     3. 全部 ACTIVE -> 排队消息，通知用户
  -> 转发后 markBusy(convKey)

Worker 完成（reply tool-call）
  -> markIdle(convKey)
  -> 检查待处理队列 -> 有则取出处理

驱逐
  -> 保存被驱逐对话的 sessionId
  -> kill tmux session
  -> 创建新 tmux session（带新对话的 --resume）

被驱逐对话回来
  -> 再次分级驱逐
  -> --resume 恢复完整上下文

Daemon 关闭
  -> 保存所有 sessionId
  -> kill 所有 tmux session
```

### 2.6 Emoji 反应（v3 状态机）

| 时机 | Emoji | 行为 |
|------|-------|------|
| 收到消息 | `Typing` | 添加（键盘动画） |
| Worker 分配 | `OnIt` | 替换 Typing |
| 回复成功 | `DONE` | 替换 OnIt（永久） |
| 错误 | `FACEPALM` | 替换当前（永久） |

所有 emoji 类型来自 openclaw-lark `VALID_FEISHU_EMOJI_TYPES`。
批量处理：回复时所有待处理消息统一转为 DONE。
无 TTL 定时清理——仅基于生命周期驱动。

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
│   │   ├── reaction-tracker.ts      # Emoji 状态机：生命周期驱动的反应管理
│   │   ├── admin.ts                 # 管理员管理：群组/管理员 CRUD
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
│   └── tests/                       # 117 个单元测试
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
├── admins.json      (由 AdminManager 管理)
├── groups.json      (由 AdminManager 管理)
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
|  5b. router: emoji 转为 OnIt                                        |
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
|  12. daemon: 批量将所有待处理消息 emoji 转为 DONE                    |
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

### 4.3 管理员管理流程（v3）

```
管理员向 bot 发送私聊（自然语言，如"把 snow 加到 sales 群"）
→ 正常路由到 Claude worker
→ Claude 理解意图，调用 manage_access 工具
→ Plugin 代理到 daemon /tool-call
→ Daemon 检查发送者权限（superadmin/admin）
→ AdminManager 执行操作，持久化到 groups.json/admins.json
→ 返回结果给 Claude → Claude 回复管理员
```

### 4.4 Worker 分配与驱逐示例（v4 — 活跃感知）

```
10 个 worker，12 个 thread 的场景：

10:00  thread_A -> worker-0 (新 session, 标记 BUSY)
10:01  thread_B -> worker-1 (新 session, 标记 BUSY)
 ...
10:09  thread_J -> worker-9 (新 session, 标记 BUSY)

10:05  worker-0 发送回复 -> thread_A 标记 IDLE

10:10  thread_K 来了，池满！
       -> thread_A 是 IDLE（从 10:05 开始）→ 驱逐
       -> thread_C 还在 BUSY → 跳过（永不驱逐活跃 worker）
       -> 保存 sessions["thread_A"] = "session-aaa"
       -> kill tmux lark-worker-0
       -> 新建 lark-worker-0，无 --resume（新对话）
       -> thread_K 分配到 worker-0，标记 BUSY

10:20  thread_L 来了，所有 worker 都 BUSY！
       -> 没有 STALE 或 IDLE worker 可驱逐
       -> thread_L 进入等待队列，通知用户"所有助手正忙"

10:21  worker-3 发送回复 -> thread_D 标记 IDLE
       -> 取出等待队列：thread_L 分配到 worker-3

10:50  thread_A 回来了
       -> thread_D 已 STALE（从 10:21 空闲至今，超过 30 分钟阈值）
       -> 保存 sessions["thread_D"] = "session-ddd"
       -> kill tmux lark-worker-3
       -> 新建 lark-worker-3 --resume session-aaa
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

### Phase 2: 权限 + 独立模式 -- 已完成
- [x] Permission 转发到飞书交互卡片（允许/拒绝按钮，文本降级）
- [x] 插件独立模式（无需 daemon 直连 WebSocket）

### Phase 3: v3 功能 -- 已完成
- [x] Emoji 状态机（Typing → OnIt → DONE/FACEPALM 生命周期）
- [x] 管理员管理（通过 Claude 自然语言群组/管理员 CRUD）
- [x] Session 持久化改进
- [x] 卡片修复与 mention 解析

### Phase 4: 测试 -- 已完成
- [x] 167 个单元测试，覆盖 12 个文件
- [x] 全部测试通过（`cd dispatcher && bun test`）

### Phase 5: 智能调度 -- 已完成
- [x] 活跃感知的 Worker 状态（ACTIVE/IDLE/STALE）
- [x] 分级驱逐：STALE > IDLE > 永不驱逐 ACTIVE
- [x] 池满时消息等待队列
- [x] Worker 空闲时自动取出排队消息
- [x] 通过 router（markBusy）和 daemon（markIdle）追踪忙闲状态

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
| Worker 无人值守时被交互确认阻塞 | System prompt 禁止交互操作 |
| 活跃 Worker 被驱逐导致任务丢失 | v4：活跃感知驱逐永不驱逐 ACTIVE worker |
| 池满（所有 Worker 都忙） | v4：消息等待队列 + 自动取出 + 用户通知 |
| 闲置 session 长期占用 Worker | v4：STALE 超时（30 分钟）优先驱逐空闲 Worker |
