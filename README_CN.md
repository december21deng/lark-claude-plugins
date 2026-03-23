# Lark Claude Plugins

[English](./README.md) | [Design Doc](./DESIGN.md) | [设计文档](./DESIGN_CN.md)

通过飞书/Lark 与 Claude Code 交互。两种模式：简单的独立模式适合个人使用，多 Worker 调度模式适合团队。

## 功能特性

### 核心功能
- **Daemon + Worker Pool** -- 基于 tmux，支持最多 10 个并行 Claude CLI worker
- **飞书 WebSocket** -- 长连接实时收发消息
- **交互式卡片回复** -- Markdown 渲染，自动检测卡片 JSON
- **Typing 表情反馈** -- Emoji 状态机 -- Typing → OnIt → DONE 生命周期（与 openclaw-lark 对齐）
- **多会话并行** -- 不同 thread 路由到不同 worker
- **会话隔离** -- 驱逐 + `--resume` 上下文恢复，互不干扰
- **全部远程 MCP** -- Clay、Gmail、Calendar、Context7，及所有 Claude Desktop MCP
- **图片支持** -- 接收（下载到 inbox）+ 发送（上传 + image_key）
- **全部飞书 msg_type** -- text、post、image、file、interactive、audio、media、sticker 等
- **卡片 JSON 自动检测** -- 原始卡片 JSON 直接发送，纯文本自动包装为 markdown 卡片；严格校验 + 文本提取降级
- **话题感知路由** -- 群聊话题组每个话题分配独立 worker
- **斜杠命令** -- `/clear`、`/new`、`/status`、`/help`

### Emoji 状态机（v3）
Typing → OnIt → DONE/FACEPALM 生命周期，与 openclaw-lark 对齐：
- 处理中显示 Typing 表情
- 正在执行任务时显示 OnIt 表情
- 完成或失败时显示 DONE 或 FACEPALM

### 管理员管理（v3）
通过 `manage_access` 工具以自然语言管理群组和管理员：
- 两级管理员体系：superadmin + admin
- 通过私聊对话添加/移除群组和管理员
- 无需斜杠命令——直接描述你想做的操作

### 会话持久化（v3）
通过 `--session-id` / `--resume` 实现 daemon 重启后会话恢复：
- Worker 会话以稳定 ID 存储
- Daemon 重启后恢复已有会话，不丢失上下文

### @提及解析
Claude 回复中的 `@_user_N` 占位符在发送前替换为真实姓名 + open_id。

### 权限转发（v2）
将 Claude 的权限确认提示转发到飞书交互卡片：
- 在飞书中向用户发送带有允许/拒绝按钮的卡片
- 支持按钮点击（`card.action.trigger_v1`）和文本回复降级（"允许"/"拒绝"）
- 2 分钟超时自动拒绝

### 插件独立模式（v2）
无需调度守护进程即可独立工作：
- 单个 Claude CLI 直连飞书 WebSocket
- 无需 tmux、daemon 或 worker pool

## 两种模式

### 独立模式 (`plugin-standalone/`)

单终端、单 Claude CLI、直连飞书 WebSocket。设置简单，无需 daemon。

```
飞书 WebSocket -> Claude CLI（带所有远程 MCP）
```

适合：个人使用，一次一个对话。

### 调度模式 (`plugin-dispatcher/` + `dispatcher/`)

多 Worker 守护进程，带进程池、会话管理和上下文隔离。支持 N 个并行对话。

```
飞书 -> Daemon（唯一 WebSocket）-> 路由 -> Worker Pool（N 个 Claude CLI）
                                              ^ 每个都有完整远程 MCP
```

适合：团队使用，多个并发对话，自动调度。

## 为什么有两种模式？

Claude Code 的远程 MCP（Clay、Gmail、Calendar 等）是 `type: "sdk"`——只有 Claude CLI 作为**主进程**时才能加载。独立模式提供最简单的配置。调度模式解决了飞书只向一个 WebSocket 连接推送消息的问题，通过 daemon 持有唯一连接并路由到多个 worker。

## 前置条件

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) 已安装
- 飞书开放平台自建应用（WebSocket 模式）
- [tmux](https://github.com/tmux/tmux)（仅调度模式：`brew install tmux`）

## 快速开始

### 1. 克隆并安装

```bash
git clone https://github.com/december21deng/lark-claude-plugins.git
cd lark-claude-plugins

# 独立模式：
bash install.sh standalone

# 调度模式：
bash install.sh dispatcher

# 两者都装：
bash install.sh both
```

### 2. 配置飞书应用

在 [飞书开放平台](https://open.larksuite.com) 创建自建应用：

1. 创建应用 -> 获取 App ID 和 App Secret
2. 添加能力 -> 机器人
3. 权限管理 -> 开通：
   - `im:message` -- 收发消息
   - `im:message:send_as_bot` -- 以机器人身份发消息
   - `im:resource` -- 上传下载资源
   - `im:message.group_msg:readonly` -- 接收群聊所有消息（不只是 @机器人的）
4. 事件与回调 -> 订阅方式选 **长连接（WebSocket）**
5. 订阅事件 -> `im.message.receive_v1`
6. 订阅事件 -> `im.message.reaction.created_v1` 和 `im.message.reaction.deleted_v1`
7. 订阅事件 -> `card.action.trigger`（权限转发按钮所需）

### 3a. 独立模式：设置凭据并启动

```bash
# 保存凭据
mkdir -p ~/.claude/channels/lark
cat > ~/.claude/channels/lark/.env << EOF
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
EOF

# 启动 Claude（带独立插件）
claude --dangerously-load-development-channels plugin:lark-standalone@local-channels
```

### 3b. 调度模式：配置并启动

```bash
# 编辑配置
cp config.example.json ~/.lark-dispatcher/config.json
vim ~/.lark-dispatcher/config.json

# 启动 daemon
cd dispatcher && bun run src/index.ts start
```

### 4. 验证

```bash
# 独立模式：直接在飞书给机器人发消息

# 调度模式：
cd dispatcher && bun run src/index.ts status
tmux ls
tmux attach -t lark-worker-0  # Ctrl+B D 退出
tail -f ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log
```

## 使用

### 飞书命令（调度模式）

| 命令 | 功能 |
|------|------|
| `/clear` | 清除当前对话，重新开始 |
| `/new` | 同 /clear |
| `/status` | 显示 worker 池状态 |
| `/help` | 帮助 |

### 多会话（调度模式）

- **私聊** -> 每个用户分配独立 worker
- **群聊话题** -> 每个话题分配独立 worker
- **群聊（无话题）** -> 整个群共享一个 worker
- 最多 N 个并行对话（通过 `maxWorkers` 配置）
- 池满时驱逐最久未活跃的对话（通过 `--resume` 恢复上下文）

### 权限控制

两种模式都通过 `~/.claude/channels/lark/access.json` 支持权限控制：

| 设置 | 说明 |
|------|------|
| `dmPolicy: "pairing"` | 需要配对码确认（默认） |
| `dmPolicy: "allowlist"` | 仅允许白名单用户 |
| `dmPolicy: "disabled"` | 禁止私聊 |
| `groupAutoReply: ["oc_xxx"]` | 这些群不需要 @mention 就回复 |

通过 skill 管理：`/lark-standalone:access` 或 `/lark-customized:access`

调度模式还支持在 config.json 中设置 `dmPolicy: "open"` 允许所有用户。

#### 两级管理员体系（v3）

| 角色 | 来源 | 可管理 |
|------|------|--------|
| superadmin | `config.json`（`lark.superadmins`） | 管理员 + 群组 |
| admin | `admins.json` | 群组 |

全部通过私聊自然语言管理——无需斜杠命令。向机器人发送如"添加群 oc_xxx"或"移除管理员 ou_yyy"即可。

### 远程 MCP

每个 Claude CLI 实例自动加载所有已连接的远程 MCP：
Clay、Gmail、Google Calendar、Context7，以及所有在 Claude Desktop 中已连接的 MCP。

## 测试

117 个单元测试，覆盖 mutex、dedup、router、session-store、receiver、reaction-tracker、admin、emoji-resolve 和 reply-threading：

```bash
cd dispatcher && bun test
```

所有测试通过。测试文件位于 `dispatcher/tests/`，包括：
- `reaction-tracker.test.ts`、`admin.test.ts`、`emoji-resolve.test.ts`、`reply-threading.test.ts`

## 配置参考（调度模式）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pool.maxWorkers` | 3 | Worker 数量 |
| `pool.basePort` | 7100 | Worker 端口起始 |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API 端口 |
| `lark.domain` | "feishu" | "feishu" 或 "lark" |
| `lark.superadmins` | [] | 拥有超级管理员权限的 open_id 数组 |
| `log.level` | "info" | 日志级别 |

## 停止（调度模式）

```bash
# 方式 1: Ctrl+C（在 daemon 终端）
# 方式 2:
cd dispatcher && bun run src/index.ts stop
```

## 代码结构

| 路径 | 职责 |
|------|------|
| `plugin-standalone/server.ts` | 独立插件：直连飞书 WebSocket + MCP 工具 |
| `plugin-dispatcher/server.ts` | 调度插件：localhost HTTP 桥接 + MCP 通知 |
| `dispatcher/src/daemon.ts` | Daemon 入口、HTTP server、信号处理 |
| `dispatcher/src/pool.ts` | Worker Pool：tmux 管理、分配、驱逐、resume |
| `dispatcher/src/router.ts` | 消息路由：convKey 计算、Mutex 排队、斜杠命令 |
| `dispatcher/src/permission.ts` | 权限转发：发送允许/拒绝交互卡片 |
| `dispatcher/src/reaction-tracker.ts` | Emoji 状态机（Typing → OnIt → DONE/FACEPALM） |
| `dispatcher/src/admin.ts` | 管理员与群组权限管理 |
| `dispatcher/src/session-store.ts` | 会话持久化（sessions.json） |
| `dispatcher/src/gateways/lark/ws.ts` | 飞书 WebSocket 连接 + 事件处理 |
| `dispatcher/src/gateways/lark/receiver.ts` | 消息解析 + 去重 + gate 权限控制 |
| `dispatcher/src/gateways/lark/api.ts` | 飞书 HTTP API（发消息、表情） |
| `dispatcher/tests/` | 117 个单元测试（mutex、dedup、router、session-store、receiver、reaction-tracker、admin、emoji-resolve、reply-threading） |

## 故障排查

<details>
<summary>消息不回复</summary>

```bash
# 独立模式：查看终端的 stderr 输出
# 调度模式：
cd dispatcher && bun run src/index.ts status
curl http://localhost:7100/health
tail -50 ~/.lark-dispatcher/logs/$(date +%Y-%m-%d).log
```
</details>

<details>
<summary>Worker 启动失败（调度模式）</summary>

```bash
tmux attach -t lark-worker-0
# 手动测试：
LARK_DISPATCHER_PORT=7100 LARK_DAEMON_PORT=8900 claude \
  --dangerously-load-development-channels plugin:lark-customized@local-channels \
  --dangerously-skip-permissions
```
</details>

<details>
<summary>端口被占用（调度模式）</summary>

```bash
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```
</details>

## License

MIT
