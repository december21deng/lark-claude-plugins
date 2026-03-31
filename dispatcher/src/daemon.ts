import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AppConfig, Gateway, ToolCallRequest, ParsedMessage } from './types.js'
import { LarkGateway } from './gateways/lark/ws.js'
import { WorkerPool } from './pool.js'
import { Router } from './router.js'
import { AdminManager, type ManageAccessArgs } from './admin.js'
import {
  buildPermissionCard,
  createPermissionRequest,
  handleCardAction,
  setCardMessageId,
  tryResolveFromText,
} from './permission.js'
import { log } from './utils/logger.js'

const TAG = 'daemon'
const DATA_DIR = join(homedir(), '.lark-dispatcher')
const INBOX_DIR = join(DATA_DIR, 'inbox')

export async function startDaemon(config: AppConfig): Promise<void> {
  mkdirSync(INBOX_DIR, { recursive: true })
  log.info(TAG, '============================================================')
  log.info(TAG, 'Lark Dispatcher starting')

  // ── Init gateways ──
  const gateways = new Map<string, Gateway>()
  const larkGw = new LarkGateway(config.lark)
  gateways.set('lark', larkGw)

  // ── Init pool (starts workers in background, daemon accepts messages immediately) ──
  const pool = new WorkerPool(config.pool, config.claude)
  await pool.init()

  // ── Admin manager ──
  const adminManager = new AdminManager(config.lark, DATA_DIR)
  larkGw.setLiveAccessConfig(() => adminManager.getLiveAccessConfig(config.lark.access))

  // ── Sender tracking (convKey → sender info + pending message IDs for emoji batch) ──
  const senderMap = new Map<string, { senderId: string; chatId: string; chatType: 'private' | 'group'; messageIds: string[] }>()

  // ── Init router ──
  const router = new Router(pool, gateways)

  // ── Start daemon HTTP server (receives tool-call from plugins) ──
  const httpServer = Bun.serve({
    port: config.pool.daemonApiPort,

    async fetch(req) {
      const url = new URL(req.url)

      // Health check
      if (url.pathname === '/health') {
        return Response.json({ ok: true, workers: config.pool.maxWorkers })
      }

      // ── Plugin → daemon: execute IM API call ──
      if (url.pathname === '/tool-call' && req.method === 'POST') {
        let body: ToolCallRequest | undefined
        try {
          body = await req.json() as ToolCallRequest
          const gw = gateways.get(body.platform)

          if (!gw) {
            return Response.json({
              result: { content: [{ type: 'text', text: `Unknown platform: ${body.platform}` }] },
              isError: true,
            })
          }

          log.info(TAG, `tool-call: ${body.tool} platform=${body.platform} convKey=${body.convKey}`)

          // v4: Heartbeat — any tool-call proves the worker is alive
          pool.heartbeat(body.convKey)

          let resultText = ''

          switch (body.tool) {
            case 'reply': {
              const chatId = body.args.chat_id as string
              const text = body.args.text as string | undefined
              const card = body.args.card as Record<string, unknown> | undefined
              const replyTo = body.args.reply_to as string | undefined
              const messageId = body.args.message_id as string | undefined
              const files = (body.args.files as string[] | undefined) ?? []
              const msgType = (body.args.msg_type as string | undefined) as import('./types.js').MsgType | undefined

              // Always reply to original message to stay in the same thread.
              // Fallback: if Claude didn't pass reply_to, use the latest messageId from senderMap.
              const senderEntry = senderMap.get(body.convKey)
              const latestMsgId = senderEntry?.messageIds[senderEntry.messageIds.length - 1]
              const replyToId = replyTo || messageId || latestMsgId
              if (!replyToId) {
                log.warn(TAG, `No reply_to for ${body.convKey}, will create new message (may break thread)`)
              }

              if (card && typeof card === 'object') {
                // Structured card object — gateway serializes it, guarantees valid JSON
                // (eliminates double-encoding bugs from Claude hand-writing JSON strings)
                if (!card.schema) card.schema = '2.0'
                await gw.sendCard(chatId, card, { replyToMessageId: replyToId })
              } else {
                // Fallback: text string path (legacy, with auto-detect)
                await gw.sendMessage(chatId, text ?? '', { replyToMessageId: replyToId, msgType })
              }

              // Upload and send image files
              for (const filePath of files) {
                try {
                  const imageKey = await gw.uploadImage(filePath)
                  await gw.sendImage(chatId, imageKey)
                  log.info(TAG, `Sent image ${filePath} to ${chatId}`)
                } catch (e) {
                  log.error(TAG, `Failed to send image ${filePath}: ${e}`)
                }
              }

              // Emoji state: DONE for ALL pending messages in this convKey
              if (senderEntry && gw instanceof LarkGateway) {
                for (const msgId of senderEntry.messageIds) {
                  await (gw as LarkGateway).tracker.transition(msgId, chatId, 'DONE').catch(() => {})
                }
                senderEntry.messageIds = [] // clear for next batch
              }
              log.info(TAG, `Reply sent to ${chatId}`)

              // v4: Mark worker idle — reply means task is done
              pool.markIdle(body.convKey)

              resultText = files.length
                ? `Message sent successfully with ${files.length} image(s)`
                : 'Message sent successfully'
              break
            }

            case 'react': {
              const chatId = body.args.chat_id as string
              const messageId = body.args.message_id as string
              const emoji = body.args.emoji as string
              await gw.addReaction(chatId, messageId, emoji)
              resultText = `Reaction ${emoji} added`
              break
            }

            case 'remove_reaction': {
              const chatId = body.args.chat_id as string
              const messageId = body.args.message_id as string
              const reactionId = body.args.reaction_id as string
              await gw.removeReaction(chatId, messageId, reactionId)
              resultText = 'Reaction removed'
              break
            }

            case 'fetch_messages': {
              const channel = body.args.channel as string
              const limit = (body.args.limit as number) ?? 20
              const msgs = await gw.fetchMessages(channel, limit)
              resultText = JSON.stringify(msgs, null, 2)
              break
            }

            // ── v2: Permission prompt forwarding ──
            case 'permission_prompt': {
              const chatId = body.args.chat_id as string
              const question = body.args.question as string
              const toolName = body.args.tool_name as string
              const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

              log.info(TAG, `Permission prompt: tool=${toolName} chat=${chatId} req=${requestId}`)

              // Build and send permission card with interactive buttons
              const card = buildPermissionCard({ question, toolName, requestId })
              const msgId = await larkGw.api.sendPermissionCard(chatId, card, {
                replyToMessageId: body.args.message_id as string | undefined,
              })
              setCardMessageId(requestId, msgId)

              // Wait for user response (button click or text reply)
              const allowed = await createPermissionRequest({
                requestId,
                convKey: body.convKey,
                chatId,
                question,
                toolName,
              })

              resultText = allowed ? 'granted' : 'denied'
              break
            }

            case 'manage_access': {
              const manageArgs = body.args as unknown as ManageAccessArgs
              const sender = senderMap.get(body.convKey)

              if (!sender) {
                resultText = 'Error: 无法确定操作者身份（未找到 sender 信息）'
                break
              }

              log.info(TAG, `manage_access: action=${manageArgs.action} sender=${sender.senderId} chatType=${sender.chatType}`)

              // DM-only check is now inside AdminManager.execute()
              const result = adminManager.execute(manageArgs, sender.senderId, sender.chatType)
              resultText = result.message

              // If adding a group, try to auto-detect chat mode via API
              if (result.ok && manageArgs.action === 'add_group' && manageArgs.target_id) {
                autoDetectChatMode(larkGw.api, adminManager, manageArgs.target_id)
              }

              if (!result.ok) {
                // Daemon sends error directly to user — don't let Claude rephrase it
                const replyToId = senderMap.get(body.convKey)?.messageIds.slice(-1)[0]
                await larkGw.sendMessage(sender.chatId, resultText, {
                  replyToMessageId: replyToId,
                  msgType: 'text',
                })
                log.info(TAG, `manage_access error sent directly to ${sender.chatId}: ${resultText}`)

                // Mark emoji as DONE since we already replied
                const senderEntry = senderMap.get(body.convKey)
                if (senderEntry) {
                  for (const msgId of senderEntry.messageIds) {
                    await larkGw.tracker.transition(msgId, sender.chatId, 'DONE').catch(() => {})
                  }
                  senderEntry.messageIds = []
                }

                return Response.json({
                  result: { content: [{ type: 'text', text: `已直接回复用户，不要再调用 reply 工具回复此消息。错误内容：${resultText}` }] },
                })
              }

              break
            }

            default:
              resultText = `Unknown tool: ${body.tool}`
          }

          return Response.json({
            result: { content: [{ type: 'text', text: resultText }] },
          })
        } catch (e) {
          log.error(TAG, `tool-call error: ${e}`)
          // v4: Mark worker idle on error — task failed, worker is free
          if (body?.convKey) {
            pool.markIdle(body.convKey)
          }
          // Emoji state: FACEPALM on ALL pending messages
          if (body?.convKey) {
            const info = senderMap.get(body.convKey)
            const errorGw = gateways.get(body.platform)
            if (info && errorGw && 'tracker' in errorGw) {
              for (const msgId of info.messageIds) {
                await (errorGw as LarkGateway).tracker.transition(msgId, info.chatId, 'FACEPALM').catch(() => {})
              }
              info.messageIds = []
            }
          }
          return Response.json({
            result: { content: [{ type: 'text', text: `Error: ${e}` }] },
            isError: true,
          })
        }
      }

      return new Response('Not Found', { status: 404 })
    },
  })

  log.info(TAG, `HTTP API listening on :${config.pool.daemonApiPort}`)

  // ── Start gateways ──
  for (const [name, gw] of gateways) {
    await gw.start(async (msg) => {
      log.info(TAG, `Incoming from ${name}: ${msg.messageId}`)

      // v2: Check if this message resolves a pending permission prompt
      const convKey = `${msg.platform}:${msg.chatId}${msg.threadId ? '_thread_' + msg.threadId : ''}`
      if (tryResolveFromText(convKey, msg.text)) {
        log.info(TAG, `Message resolved a pending permission prompt for ${convKey}`)
        return // Don't route to worker — it was a permission response
      }

      // Download image attachments before routing to worker
      if (msg.attachments?.length) {
        await downloadAttachments(gw, msg)
      }

      // Track sender + pending messageIds for emoji batch processing
      const existing = senderMap.get(convKey)
      if (existing) {
        existing.messageIds.push(msg.messageId)
      } else {
        senderMap.set(convKey, { senderId: msg.senderId, chatId: msg.chatId, chatType: msg.chatType, messageIds: [msg.messageId] })
      }

      // Route (async, don't await — let the gateway continue receiving)
      router.route(msg).catch(e => log.error(TAG, `Route error: ${e}`))
    })
    log.info(TAG, `Gateway "${name}" started`)
  }

  log.info(TAG, 'Dispatcher ready')

  // ── Signal handling ──
  const shutdown = async () => {
    log.info(TAG, 'Shutting down...')
    httpServer.stop()
    await pool.shutdown()
    for (const gw of gateways.values()) {
      await gw.stop().catch(() => {})
    }
    log.info(TAG, 'Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// ── Auto-detect group chat mode ──

async function autoDetectChatMode(
  api: import('./gateways/lark/api.js').LarkApi,
  adminManager: AdminManager,
  chatId: string,
): Promise<void> {
  try {
    const res = await (api.client as any).im.chat.get({
      path: { chat_id: chatId },
    })
    const chatMode = res?.data?.chat_mode ?? 'group'
    const mode: 'group' | 'topic' = chatMode === 'topic' ? 'topic' : 'group'
    adminManager.updateGroupChatMode(chatId, mode)
    log.info(TAG, `Auto-detected chat mode for ${chatId}: ${mode}`)
  } catch (e) {
    log.warn(TAG, `Failed to auto-detect chat mode for ${chatId}: ${e}`)
  }
}

// ── Image download helper ──

async function downloadAttachments(gw: Gateway, msg: ParsedMessage): Promise<void> {
  if (!msg.attachments?.length) return

  const savedPaths: string[] = []
  for (const att of msg.attachments) {
    if (att.type === 'image' && att.imageKey) {
      try {
        const buf = await gw.downloadImage(msg.messageId, att.imageKey)
        const ext = 'png'
        const filename = `${Date.now()}-${msg.messageId.slice(-8)}-${att.imageKey.slice(-8)}.${ext}`
        const localPath = join(INBOX_DIR, filename)
        writeFileSync(localPath, buf)
        att.localPath = localPath
        savedPaths.push(localPath)
        log.info(TAG, `Downloaded image ${att.imageKey} → ${localPath} (${(buf.length / 1024).toFixed(0)}KB)`)
      } catch (e) {
        log.error(TAG, `Failed to download image ${att.imageKey}: ${e}`)
      }
    }
  }

  // Append download info to message text so Claude knows where the images are
  if (savedPaths.length) {
    const pathList = savedPaths.map(p => `  ${p}`).join('\n')
    msg.text += `\n\n[用户发送了${savedPaths.length}张图片，已保存到以下路径，请用 Read 工具查看：\n${pathList}]`
  }
}
