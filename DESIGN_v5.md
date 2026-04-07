# Feishu Dispatcher v5 设计方案

## 一、核心变更：无状态 + 动态池 + 话题历史

### 现状问题

- Worker 切换对话需要 kill + `--resume` 重启，耗时 20-60s
- 重启后 MCP 就绪时序不可靠，消息丢失
- Session 管理增加了复杂度（SessionStore、eviction 分级、session 持久化）
- 不同对话复用同一 Worker 存在上下文污染风险
- 固定池大小，高峰期所有 Worker BUSY 时新消息必须排队

### 新方案

- Worker 不保存 session，全部 bare 启动
- 对话结束后通过 `/clear` 清除上下文（MCP 连接保持，0 延迟恢复 BARE）
- 动态进程池：最少 10 个常驻，最多 30 个按需 spawn
- 话题群消息：转发前拉该话题全部历史消息，作为上下文注入
- 私聊消息：只发当前消息，不拉历史

---

## 二、动态进程池

### 池参数

| 参数 | 默认值 | 配置项 | 说明 |
|------|--------|--------|------|
| 最小常驻 | **10** | `pool.minWorkers` | 始终保持至少 10 个 worker 进程 |
| 最大上限 | **30** | `pool.maxWorkers` | 防止 OOM，不再 spawn |

### 状态定义（3 种）

| 状态 | 条件 | 说明 |
|------|------|------|
| **BARE** | `convKey === null` | 无上下文，可立即分配 |
| **BUSY** | `busy === true` | 正在处理消息 |
| **IDLE** | `busy === false && convKey !== null` | 绑定了对话，等待中 |

> 相比原方案去掉了 RECYCLABLE 状态，因为 `/clear` 让 IDLE→BARE 变成了零成本操作。

### Worker 生命周期

```
spawn → MCP ready → BARE
  ↓
收到消息 → BUSY
  ↓
reply tool → IDLE
  ├─ 同一 convKey 来新消息 → BUSY（复用，0 延迟）
  ├─ 1min 无新消息 → tmux send "/clear" → BARE（即时，0 延迟）
  └─ 5min 仍无消息 且 当前 worker 数 > minWorkers → kill（回收资源）
```

### 完整生命周期图

```
                          ┌──────────────────────────────┐
                          │                              │
                          ▼                              │
  spawn ──→ MCP ready ──→ BARE ──消息──→ BUSY ──reply──→ IDLE
              ▲             ▲                              │
              │             │     /clear (1min)            │
              │             └──────────────────────────────┘
              │
         kill + respawn
         (5min 空闲 且 > minWorkers)
```

### 阈值配置

| 参数 | 默认值 | 配置项 | 说明 |
|------|--------|--------|------|
| 清理延迟 | **1 分钟** | `pool.clearDelayMs` | IDLE 后多久发 `/clear`，解绑 convKey |
| 回收延迟 | **5 分钟** | `pool.killDelayMs` | BARE 后多久 kill（仅超过 minWorkers 时） |
| BUSY 兜底超时 | **10 分钟** | `pool.busyTimeoutMs` | 无 heartbeat 超此时间，强制 markIdle（crash 恢复） |

### getWorker(convKey) 调度流程

```
Step 1: convKey 已绑定某个 worker？
  ├─ 是，且 healthy → 直接复用（即使 BUSY，消息由 Mutex 串行化）
  └─ 是，但 unhealthy → 重启同一 worker，重新绑定

Step 2: 有 BARE worker？
  └─ 直接分配（最快路径，0 延迟）

Step 3: 当前 worker 总数 < maxWorkers？
  └─ spawn 新 worker，等 MCP ready 后分配（~30s）

Step 4: 全部 BUSY 且已达 maxWorkers
  └─ 消息进 pending queue（最多 50 条）
     有 worker 空闲后自动 drain
```

**关键原则：**

- BUSY worker **永不驱逐**
- IDLE worker 收到**同一 convKey** 新消息 → 直接复用，取消 `/clear` 定时器
- IDLE worker 收到**不同 convKey** 新消息 → 不抢占，走 Step 2-4
- `/clear` 定时器获取 Mutex 后执行，避免和消息处理竞争

### BUSY 状态判定

```
消息转发给 worker → markBusy(convKey)        ← router.ts 调用
  ↓
Claude 思考 + 调工具（search/read/etc）
  ↓  每次 tool-call → heartbeat(convKey)      ← daemon.ts 调用，更新 lastActivityAt
  ↓
Claude 调 reply tool → markIdle(convKey)      ← daemon.ts 调用
```

| 事件 | 触发点 | busy 值 |
|------|--------|---------|
| 消息 POST 到 plugin 成功 | `router.ts` 转发后 | `true` |
| Worker 调了 reply tool | `daemon.ts` 处理 reply | `false` |
| Worker 调了任何 tool | `daemon.ts` 处理 tool-call | 不变，只更新 lastActivityAt |
| tool-call 报错 | `daemon.ts` catch 块 | `false`（markIdle） |
| **10 分钟无 heartbeat** | **定时器兜底** | **强制 `false`（crash 恢复）** |

> **注意**：Claude Code 的内部工具（Read、Write、Bash、Grep、Agent）不经过 daemon，
> 不会产生 heartbeat。因此 BUSY 兜底超时设为 10 分钟，留足裕量。

### `/clear` 清理机制

```
markIdle(convKey) 被调用
  → 启动 1 分钟定时器
  → 1 分钟内来了同一 convKey 新消息 → 取消定时器（worker 继续复用）
  → 1 分钟内没有新消息 → 获取 Mutex → tmux send-keys "/clear\n" → 解绑 convKey → BARE
    → 如果当前 worker 总数 > minWorkers → 启动 5 分钟定时器
      → 5 分钟内没有被分配 → kill worker（回收资源）
      → 被分配了 → 取消 kill 定时器
```

### 动态 spawn 机制

```
getWorker() 发现没有 BARE worker 且 当前数 < maxWorkers
  → spawn 新 tmux session + Claude Code 进程
  → 等待 MCP ready（/health 返回 ready: true）
  → 标记为 BARE → 立即分配给请求的 convKey
```

### 删除的机制

- ~~SessionStore / sessions.json~~
- ~~`--resume` / `--session-id` 启动参数~~
- ~~三级 eviction（STALE → IDLE → ACTIVE）~~
- ~~`_lastUsed` Map~~
- ~~`_assignAndStart()`~~
- ~~RECYCLABLE 状态~~

---

## 三、话题历史注入

### 触发条件

- 消息有 `threadId`（话题群内的消息）→ 拉历史
- 消息无 `threadId`（私聊 / 普通群）→ 不拉

### 拉取方式

在 `router.ts` 转发前，调用飞书 API：

```typescript
// GET /open-apis/im/v1/messages
// params: { container_id_type: 'thread', container_id: threadId, page_size: 50 }
```

### 格式化

```xml
<history thread_id="tm_xxx">
[14:01] 张三: 帮我查一下上个月的销售数据
[14:02] bot: 上个月总销售额 320 万，环比增长 12%
[14:05] 张三: 那同比呢？
</history>

再帮我看看利润率
```

**规则：**

- 最多拉 50 条（话题内全部，或接近全部）
- bot 的回复也拉（Claude 需要知道自己之前说了什么）
- bot 回复是卡片 JSON → 提取纯文本显示
- 按时间正序排列
- 当前消息不包含在 `<history>` 里，放在外面

### 系统提示词补充

在 worker 的 `--append-system-prompt` 中加一条：

> 如果消息中包含 `<history>` 标签，那是该话题的历史聊天记录，用于帮助你理解上下文。你只需要回复最新的消息（`<history>` 标签外的内容），不要回复历史消息。

---

## 四、Plugin MCP 就绪检查

### 问题

plugin 的 `/health` 在 HTTP server 启动就返回 `ready: true`，但 Claude Code 的 MCP notification handler 可能还没就绪。消息发了就丢。

### 修复

- 新增 `_mcpReady` flag，初始 `false`
- Claude Code 调用 `ListTools` 时设为 `true`（Claude Code 初始化 MCP 时一定会调 ListTools）
- `/health` 只在 `_mcpReady === true` 时返回 `ready: true`
- MCP 未就绪时收到的消息缓冲在 `_pendingNotifications` 数组中
- `ListTools` 被调用后自动 flush 所有缓冲的消息
- `void mcp.notification()` → `await mcp.notification()` + error logging

---

## 五、Admin / 群管理（已有，无需改动）

现有的 `manage_access` tool + `AdminManager` 已完整支持：

- `add_group` / `remove_group` / `list_groups`
- `add_admin` / `remove_admin` / `list_admins`
- superadmin 权限校验
- 私聊限制（group 操作只能在私聊中执行）
- 自动检测群聊模式（group / topic）

Worker 的系统提示词已包含使用说明，无需改动。

---

## 六、涉及的文件改动

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `pool.ts` | **重写** | 动态池（min/max）、3 种状态、`/clear` 清理、spawn/kill 逻辑、Mutex 保护定时器 |
| `router.ts` | **修改** | 转发前拉话题历史，格式化注入 |
| `gateways/lark/api.ts` | **新增方法** | `fetchThreadMessages(threadId, limit)` — 拉话题内消息 |
| `plugin-dispatcher/server.ts` | **修改** | MCP 就绪检查 + 消息缓冲 + notification await |
| `session-store.ts` | **删除** | 不再需要 |
| `types.ts` | **小改** | PoolConfig 改为 `minWorkers`、`maxWorkers`、`clearDelayMs`、`killDelayMs`、`busyTimeoutMs` |
| `daemon.ts` | **小改** | 传 botOpenId 给 router 用于历史消息中识别 bot 回复 |

### 不变的部分

- `admin.ts` — 权限管理
- `permission.ts` — 权限卡片
- `reaction-tracker.ts` — emoji 状态管理
- `gateways/lark/ws.ts` — WebSocket 连接
- `gateways/lark/receiver.ts` — 消息解析 + 门控
- `config.ts` — 配置加载
- `index.ts` — CLI 入口
- daemon.ts 中的 tool-call 处理逻辑（reply/react/manage_access 等）
