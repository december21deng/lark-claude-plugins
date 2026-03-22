# Feishu Dispatcher

飞书 × Claude Code 混合调度系统。通过飞书与 Claude Code 交互，支持多会话并行、上下文隔离、远程 MCP（Clay、Gmail、Calendar 等）。

## 架构

```
飞书 → Daemon（唯一 WebSocket）→ 路由 → Worker Pool（10 个 Claude CLI）
                                              ↑ 每个都有完整远程 MCP
```

- **Daemon** 持有唯一的飞书 WebSocket 连接，接收所有消息
- **Worker Pool** 由 10 个 Claude CLI 进程组成，运行在 tmux session 中
- 每个 Worker 是完整的 Claude CLI 主进程，自动加载所有远程 MCP
- 不同对话（thread）分配到不同 Worker，上下文完全隔离
- 驱逐时 kill + `--resume` 重建，上下文无损恢复

## 前置条件

- macOS
- [Bun](https://bun.sh/) v1.0+
- [Claude Code CLI](https://claude.ai/code) 已安装
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- 飞书开放平台自建应用（WebSocket 模式）

## 快速开始

### 1. 安装

```bash
cd ~/feishu-dispatcher
bash install.sh
```

### 2. 配置飞书应用

在 [飞书开放平台](https://open.feishu.cn) 创建自建应用：

1. 创建应用 → 获取 App ID 和 App Secret
2. 添加能力 → 机器人
3. 权限管理 → 开通 `im:message`、`im:message:send_as_bot`、`im:resource`
4. 事件与回调 → 订阅方式选 **长连接（WebSocket）**
5. 订阅事件 → `im.message.receive_v1`

### 3. 编辑配置

```bash
vim ~/.feishu-dispatcher/config.json
```

```json
{
  "feishu": {
    "appId": "cli_你的appId",
    "appSecret": "你的appSecret",
    "domain": "feishu",
    "access": {
      "dmPolicy": "open",
      "allowFrom": [],
      "groups": {},
      "groupAutoReply": ["oc_你的群chatId"]
    }
  },
  "pool": {
    "maxWorkers": 10,
    "basePort": 7100,
    "daemonApiPort": 8900
  },
  "claude": {
    "bin": "/Users/你的用户名/.local/bin/claude",
    "pluginChannel": "plugin:feishu-customized@local-channels"
  },
  "log": {
    "level": "info",
    "dir": "/Users/你的用户名/.feishu-dispatcher/logs"
  }
}
```

### 4. 启动

```bash
cd ~/feishu-dispatcher && bun run src/index.ts start
```

Daemon 会自动：
1. 预信任工作目录
2. 创建 10 个 tmux worker session
3. 自动确认所有启动提示
4. 连接飞书 WebSocket
5. 开始接收消息

### 5. 验证

```bash
# 查看状态
bun run src/index.ts status

# 查看 worker 列表
tmux ls

# 查看某个 worker 的终端
tmux attach -t fd-worker-0
# (Ctrl+B D 退出 tmux attach)

# 查看日志
tail -f ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log
```

在飞书中私聊或 @机器人 发消息，应该收到回复。

## 使用

### 飞书命令

| 命令 | 功能 |
|------|------|
| `/clear` | 清除当前对话，重新开始 |
| `/new` | 同 /clear |
| `/status` | 显示 worker 池状态 |
| `/help` | 帮助 |

### 多会话

- **私聊** → 每个用户的私聊分配到独立 worker
- **群聊话题** → 每个话题（thread）分配到独立 worker
- **群聊（无话题）** → 整个群共享一个 worker
- 最多 10 个并行对话（可在 config 中调整 `maxWorkers`）
- 超过 10 个时，最久未活跃的对话被驱逐（上下文通过 `--resume` 恢复）

### 权限控制

`config.json` 中的 `access` 配置：

| 设置 | 说明 |
|------|------|
| `dmPolicy: "open"` | 任何人都可以私聊 |
| `dmPolicy: "pairing"` | 需要配对码确认 |
| `dmPolicy: "disabled"` | 禁止私聊 |
| `groupAutoReply: ["oc_xxx"]` | 这些群不需要 @mention 就回复 |

### 远程 MCP

每个 Worker 是 Claude CLI 主进程，自动加载所有已连接的远程 MCP：

- Clay（公司信息查询）
- Gmail（邮件读写）
- Google Calendar（日程管理）
- Context7（文档查询）
- 所有在 Claude Desktop 中已连接的 MCP

## 停止

```bash
# 方式 1: Ctrl+C（在 daemon 终端）
# 方式 2: 命令
cd ~/feishu-dispatcher && bun run src/index.ts stop
```

会自动保存所有 session ID 并清理 tmux session。

## 配置参考

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `pool.maxWorkers` | 10 | Worker 数量 |
| `pool.basePort` | 7100 | Worker 端口起始 |
| `pool.daemonApiPort` | 8900 | Daemon HTTP API 端口 |
| `feishu.domain` | "feishu" | "feishu" 或 "lark" |
| `log.level` | "info" | 日志级别 |

## 故障排查

### 消息不回复
```bash
# 1. 检查 daemon 是否在运行
bun run src/index.ts status

# 2. 检查 worker 是否健康
curl http://localhost:7100/health

# 3. 检查是否有其他进程抢飞书 WebSocket
ps aux | grep "lark-mcp\|bun.*server" | grep -v grep

# 4. 查看日志
tail -50 ~/.feishu-dispatcher/logs/$(date +%Y-%m-%d).log
```

### Worker 启动失败
```bash
# 查看 worker 终端
tmux attach -t fd-worker-0

# 手动启动测试
FEISHU_DISPATCHER_PORT=7100 FEISHU_DAEMON_PORT=8900 claude --dangerously-load-development-channels plugin:feishu-customized@local-channels --dangerously-skip-permissions
```

### 端口被占用
```bash
# 释放端口
lsof -ti:8900 | xargs kill -9
lsof -ti:7100 | xargs kill -9
```

## 开发

### 代码结构

| 文件 | 职责 |
|------|------|
| `src/daemon.ts` | Daemon 入口、HTTP server、信号处理 |
| `src/pool.ts` | Worker Pool：tmux 管理、分配、驱逐、resume |
| `src/router.ts` | 消息路由：convKey 计算、Mutex 排队、斜杠命令 |
| `src/gateways/feishu/ws.ts` | 飞书 WebSocket 连接 + 事件处理 |
| `src/gateways/feishu/receiver.ts` | 消息解析 + 去重 + gate 权限控制 |
| `src/gateways/feishu/api.ts` | 飞书 HTTP API（发消息、表情） |
| `plugin/server.ts` | Channel 插件：localhost HTTP + MCP notification |

### 设计文档

详见 [feishu-dispatcher-design.md](../feishu-dispatcher-design.md)

## License

MIT
