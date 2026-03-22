import type { AppConfig, Gateway, ToolCallRequest } from './types.js'
import { FeishuGateway } from './gateways/feishu/ws.js'
import { WorkerPool } from './pool.js'
import { Router } from './router.js'
import { log } from './utils/logger.js'

const TAG = 'daemon'

export async function startDaemon(config: AppConfig): Promise<void> {
  log.info(TAG, '============================================================')
  log.info(TAG, 'Feishu Dispatcher starting')

  // ── Init gateways ──
  const gateways = new Map<string, Gateway>()
  const feishuGw = new FeishuGateway(config.feishu)
  gateways.set('feishu', feishuGw)

  // ── Init pool (starts workers in background, daemon accepts messages immediately) ──
  const pool = new WorkerPool(config.pool, config.claude)
  await pool.init()

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

      // Plugin → daemon: execute IM API call
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
              // Always reply to the original message so it stays in the thread
              await gw.sendMessage(chatId, text, { replyToMessageId: replyTo || messageId })

              // Remove Typing indicator
              if (messageId && gw instanceof FeishuGateway) {
                await (gw as FeishuGateway).ackDone(messageId)
              }
              log.info(TAG, `Reply sent to ${chatId}, typing removed for ${messageId ?? 'unknown'}`)

              resultText = 'Message sent successfully'
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

      return new Response('Not Found', { status: 404 })
    },
  })

  log.info(TAG, `HTTP API listening on :${config.pool.daemonApiPort}`)

  // ── Start gateways ──
  for (const [name, gw] of gateways) {
    await gw.start(async (msg) => {
      log.info(TAG, `Incoming from ${name}: ${msg.messageId}`)
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
