# Feishu Dispatcher

[English](./README.md) | [Design Doc](./DESIGN.md) | [设计文档](./DESIGN_CN.md)

飞书 × Claude Code 混合调度系统。通过飞书与 Claude Code 交互，支持多会话并行、上下文隔离、远程 MCP（Clay、Gmail、Calendar 等）。

## 架构

```
飞书 → Daemon（唯一 WebSocket）→ 路由 → Worker Pool（N 个 Claude CLI）
                                              ↑ 每个都有完整远程 MCP
```

- **Daemon** 持有唯一的飞书 WebSocket 连接，接收所有消息
- **Worker Pool** 由 N 个 Claude CLI 进程组成，运行在 tmux session 中
- 每个 Worker 是完整的 Claude CLI 主进程，自动加载所有远程 MCP
- 不同对话（thread）分配到不同 Worker，上下文完全隔离
- 驱逐时 kill + `--resume` 重建，上下文无损恢复

## 为什么用这个架构？

Claude Code 的远程 MCP（Clay、Gmail、Calendar 等）是 `type: "sdk"`——只有 Claude CLI 作为**主进程**时才能加载。子进程方式（如 NeoClaw 的 `--input-format stream-json`）无法加载这些 MCP。

但每个 Claude CLI 各自连飞书 WebSocket 时，飞书只推消息给其中一个连接。解决方案：daemon 持有唯一 WebSocket，通过 localhost HTTP 路由消息到 Worker。

## 前置条件

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) 已安装
- [tmux](https://github.com/tmux/tmux)（`brew install tmux`）
- 飞书开放平台自建应用（WebSocket 模式）

## 快速开始

### 1. 安装

```bash
git clone https://github.com/december21deng/lark-claude-plugins.git
cd lark-claude-plugins
bash install.sh
```

### 2. 配置飞书应用

在 [飞书开放平台](https://open.feishu.cn) 创建自建应用：

1. 创建应用 → 获取 App ID 和 App Secret
2. 添加能力 → 机器人
3. 权限管理 → 开通：
   - `im:message` — 收发消息
   - `im:message:send_as_bot` — 以机器人身份发消息
   - `im:resource` — 上传下载资源
   - `im:message.group_msg:readonly` — 接收群聊所有消息（不只是 @机器人的）
4. 事件与回调 → 订阅方式选 **长连接（WebSocket）**
5. 订阅事件 → `im.message.receive_v1`

### 3. 编辑配置

```bash
cp config.example.json ~/.feishu-dispatcher/config.json
vim ~/.feishu-dispatcher/config.json
```

填入 `appId`、`appSecret`、`bin` 路径和 `groupAutoReply` 群 ID。

### 4. 启动

```bash
bun run src/index.ts start
```

Daemon 会自动：
1. 预信任工作目录
2. 创建 N 个 tmux worker session 并自动确认提示
3. 连接飞书 WebSocket
4. 第一个 worker ready 后立即开始接收消息

### 5. 验证

```bash
bun run src/index.ts status          # 查看状态
tmux ls                              # 查看 worker 列表
tmux attach -t fd-worker-0           # 进入 worker 终端（Ctrl+B D 退出）
tail -f ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log  # 查看日志
```

## 使用

### 飞书命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清除当前对话，重新开始 |
| `/new` | 同 /clear |
| `/status` | 显示 worker 池状态 |
| `/help` | 帮助 |

### 多会话

- **私聊** → 每个用户分配独立 worker
- **群聊话题** → 每个话题分配独立 worker
- **群聊（无话题）** → 整个群共享一个 worker
- 最多 N 个并行对话（通过 `maxWorkers` 配置）
- 池满时驱逐最久未活跃的对话（通过 `--resume` 恢复上下文）

### Worker 池管理

```
thread_A 消息1 → worker-0（新分配）
thread_A 消息2 → worker-0（复用，上下文连续）
thread_B 消息1 → worker-1（空闲 worker 分配）
...池满...
thread_C 来了 → 驱逐最旧 → kill → --resume 重启 → 服务 thread_C
thread_A 回来 → 驱逐最旧 → --resume session_A → 上下文完整恢复
```

### 权限控制

| 设置 | 说明 |
|------|------|
| `dmPolicy: "open"` | 任何人都可以私聊 |
| `dmPolicy: "pairing"` | 需要配对码确认 |
| `dmPolicy: "disabled"` | 禁止私聊 |
| `groupAutoReply: ["oc_xxx"]` | 这些群不需要 @mention 就回复 |

### 远程 MCP

每个 Worker 自动加载所有已连接的远程 MCP：
Clay、Gmail、Google Calendar、Context7，以及所有在 Claude Desktop 中已连接的 MCP。

## 配置参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pool.maxWorkers` | 10 | Worker 数量 |
| `pool.basePort` | 7100 | Worker 端口起始 |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API 端口 |
| `feishu.domain` | "feishu" | "feishu" 或 "lark" |
| `log.level` | "info" | 日志级别 |

## 停止

```bash
# 方式 1: Ctrl+C（在 daemon 终端）
# 方式 2:
bun run src/index.ts stop
```

## 故障排查

<details>
<summary>消息不回复</summary>

```bash
bun run src/index.ts status
curl http://localhost:7100/health
ps aux | grep "lark-mcp\|bun.*server" | grep -v grep
tail -50 ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log
```
</details>

<details>
<summary>Worker 启动失败</summary>

```bash
tmux attach -t fd-worker-0
# 手动测试：
FEISHU_DISPATCHER_PORT=7100 FEISHU_DAEMON_PORT=8900 claude \
  --dangerously-load-development-channels plugin:feishu-customized@local-channels \
  --dangerously-skip-permissions
```
</details>

<details>
<summary>端口被占用</summary>

```bash
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```
</details>

## 代码结构

| 文件 | 职责 |
|------|------|
| `src/daemon.ts` | Daemon 入口、HTTP server、信号处理 |
| `src/pool.ts` | Worker Pool：tmux 管理、分配、驱逐、resume |
| `src/router.ts` | 消息路由：convKey 计算、Mutex 排队、斜杠命令 |
| `src/gateways/feishu/ws.ts` | 飞书 WebSocket 连接 + 事件处理 |
| `src/gateways/feishu/receiver.ts` | 消息解析 + 去重 + gate 权限控制 |
| `src/gateways/feishu/api.ts` | 飞书 HTTP API（发消息、表情） |
| `plugin/server.ts` | Channel 插件：localhost HTTP + MCP notification 桥接 |

## License

MIT
