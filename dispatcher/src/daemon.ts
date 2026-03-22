import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { AppConfig, Gateway, ToolCallRequest, ParsedMessage } from './types.js'
import { LarkGateway } from './gateways/lark/ws.js'
import { WorkerPool } from './pool.js'
import { Router } from './router.js'
import { StreamingCardManager } from './streaming-card.js'
import {
  buildPermissionCard,
  createPermissionRequest,
  handleCardAction,
  setCardMessageId,
  tryResolveFromText,
} from './permission.js'
import { log } from './utils/logger.js'

const TAG = 'daemon'
const INBOX_DIR = join(homedir(), '.lark-dispatcher', 'inbox')

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

  // ── Init router ──
  const router = new Router(pool, gateways)

  // ── Init streaming card manager (uses LarkApi directly) ──
  const streamingCards = new StreamingCardManager(larkGw.api)

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
        try {
          const body = await req.json() as ToolCallRequest
          const gw = gateways.get(body.platform)

          if (!gw) {
            return Response.json({
              result: { content: [{ type: 'text', text: `Unknown platform: ${body.platform}` }] },
              isError: true,
            })
          }

          log.info(TAG, `tool-call: ${body.tool} platform=${body.platform} convKey=${body.convKey}`)

          let resultText = ''

          switch (body.tool) {
            case 'reply': {
              const chatId = body.args.chat_id as string
              const text = body.args.text as string
              const replyTo = body.args.reply_to as string | undefined
              const messageId = body.args.message_id as string | undefined
              const files = (body.args.files as string[] | undefined) ?? []
              const msgType = (body.args.msg_type as string | undefined) as import('./types.js').MsgType | undefined

              // If there's an active streaming card, finalize it with the reply text
              // and skip sending a separate message
              if (streamingCards.has(body.convKey)) {
                await streamingCards.done(body.convKey, text)
                // Still send images if any
                for (const filePath of files) {
                  try {
                    const imageKey = await gw.uploadImage(filePath)
                    await gw.sendImage(chatId, imageKey)
                    log.info(TAG, `Sent image ${filePath} to ${chatId}`)
                  } catch (e) {
                    log.error(TAG, `Failed to send image ${filePath}: ${e}`)
                  }
                }
              } else {
                // No streaming card — send as regular message
                await gw.sendMessage(chatId, text, { replyToMessageId: replyTo || messageId, msgType })

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
              }

              // Remove Typing indicator
              if (messageId && gw instanceof LarkGateway) {
                await (gw as LarkGateway).ackDone(messageId)
              }
              log.info(TAG, `Reply sent to ${chatId}, typing removed for ${messageId ?? 'unknown'}`)

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

            default:
              resultText = `Unknown tool: ${body.tool}`
          }

          // If plugin reports a sessionId, update the store
          if (body.args._sessionId) {
            pool.updateSessionId(body.convKey, body.args._sessionId as string)
          }

          return Response.json({
            result: { content: [{ type: 'text', text: resultText }] },
          })
        } catch (e) {
          log.error(TAG, `tool-call error: ${e}`)
          return Response.json({
            result: { content: [{ type: 'text', text: `Error: ${e}` }] },
            isError: true,
          })
        }
      }

      // ── v2: Plugin → daemon: stream events for streaming cards ──
      if (url.pathname === '/stream-event' && req.method === 'POST') {
        try {
          const body = await req.json() as {
            type: 'start' | 'tool_use' | 'text_delta' | 'done'
            convKey: string
            chatId?: string
            replyToMessageId?: string
            toolName?: string
            toolInput?: unknown
            text?: string
          }

          log.info(TAG, `stream-event: type=${body.type} convKey=${body.convKey}`)

          switch (body.type) {
            case 'start': {
              if (!body.chatId) {
                return Response.json({ error: 'chatId required for start' }, { status: 400 })
              }
              await streamingCards.start(body.convKey, body.chatId, body.replyToMessageId)
              break
            }

            case 'tool_use': {
              if (body.toolName) {
                await streamingCards.addToolStep(body.convKey, body.toolName, body.toolInput)
              }
              break
            }

            case 'text_delta': {
              if (body.text !== undefined) {
                await streamingCards.updateText(body.convKey, body.text)
              }
              break
            }

            case 'done': {
              await streamingCards.done(body.convKey, body.text)
              break
            }
          }

          return Response.json({ ok: true })
        } catch (e) {
          log.error(TAG, `stream-event error: ${e}`)
          return Response.json({ error: String(e) }, { status: 500 })
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
