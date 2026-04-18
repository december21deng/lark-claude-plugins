/**
 * Mail Watcher — subscribes to a set of Feishu mailboxes and forwards
 * incoming mails (with attachments) into the dispatcher's router as
 * ParsedMessage events with platform="mail".
 *
 * Design notes:
 * - Spawns one child process per mailbox: `lark-cli mail +watch --mailbox <email>`
 * - Reads NDJSON from child's stdout
 * - For each incoming message with attachments:
 *   1. Skip if already in processed list
 *   2. Download attachments to local dir
 *   3. Build a ParsedMessage and emit it via onMessage()
 * - NO invoice-specific logic lives here. Whether a mail is an invoice or not
 *   is decided downstream (inside the worker's skill).
 */

import { spawn, type ChildProcess } from 'child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { MailConfig, MailSubscription, ParsedMessage, Attachment } from '../../types.js'
import { log } from '../../utils/logger.js'

const TAG = 'mail-watcher'

// Public event — mail-watcher emits these; router.route() consumes them.
type OnMessage = (msg: ParsedMessage) => void

interface WatcherChild {
  subscription: MailSubscription
  proc: ChildProcess
  restarts: number
  lastRestartAt: number
}

export class MailWatcher {
  private _cfg: MailConfig
  private _children: WatcherChild[] = []
  private _onMessage?: OnMessage
  private _stopped = false
  private _processed: Set<string> = new Set()

  private readonly _bin: string
  private readonly _inboxDir: string
  private readonly _processedFile: string

  constructor(cfg: MailConfig) {
    this._cfg = cfg
    this._bin = cfg.larkCliBin ?? 'lark-cli'
    this._inboxDir = cfg.inboxDir ?? join(homedir(), '.lark-dispatcher', 'mail-inbox')
    this._processedFile = cfg.processedFile ?? join(homedir(), '.lark-dispatcher', 'mail-processed.json')

    mkdirSync(this._inboxDir, { recursive: true })
    this._loadProcessed()
  }

  async start(onMessage: OnMessage): Promise<void> {
    this._onMessage = onMessage

    if (!this._cfg.enabled) {
      log.info(TAG, 'Mail watcher disabled (mail.enabled=false). Skipping.')
      return
    }
    if (!this._cfg.subscriptions.length) {
      log.info(TAG, 'Mail watcher enabled but no subscriptions. Skipping.')
      return
    }

    log.info(TAG, `Starting mail watcher for ${this._cfg.subscriptions.length} mailbox(es)`)
    for (const sub of this._cfg.subscriptions) {
      this._spawnOne(sub)
    }
  }

  async stop(): Promise<void> {
    this._stopped = true
    for (const c of this._children) {
      try { c.proc.kill('SIGTERM') } catch {}
    }
    this._children = []
    log.info(TAG, 'Mail watcher stopped')
  }

  // ── Private ──

  private _spawnOne(sub: MailSubscription): void {
    log.info(TAG, `Spawning watcher for ${sub.email} (${sub.ownerName ?? sub.ownerOpenId})`)

    // Use --msg-format metadata (lightweight). We'll re-fetch full content
    // with `lark-cli mail +message` only when we actually need it.
    const proc = spawn(this._bin, [
      'mail', '+watch',
      '--mailbox', sub.email,
      '--folders', '["inbox"]',
      '--msg-format', 'metadata',
      '--format', 'data',
      '--as', 'user',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const child: WatcherChild = { subscription: sub, proc, restarts: 0, lastRestartAt: Date.now() }
    this._children.push(child)

    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      // NDJSON: split by newline, parse each
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t) continue
        try {
          const evt = JSON.parse(t)
          this._handleEvent(sub, evt).catch(e => log.error(TAG, `handleEvent error: ${e}`))
        } catch (e) {
          log.warn(TAG, `Bad NDJSON line from ${sub.email}: ${t.slice(0, 200)}`)
        }
      }
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      // lark-cli may print info on stderr; demote to debug
      const txt = chunk.toString('utf8').trim()
      if (txt) log.warn(TAG, `[${sub.email} stderr] ${txt.slice(0, 400)}`)
    })

    proc.on('close', (code, signal) => {
      if (this._stopped) return
      log.warn(TAG, `watcher for ${sub.email} exited (code=${code}, signal=${signal}). Restarting in 5s`)
      // Cap restart rate: at most 1 per 5s per mailbox
      setTimeout(() => {
        if (this._stopped) return
        child.restarts++
        child.lastRestartAt = Date.now()
        this._spawnOne(sub)
      }, 5000)
      // Remove this dead child from list
      this._children = this._children.filter(c => c !== child)
    })
  }

  private async _handleEvent(sub: MailSubscription, evt: any): Promise<void> {
    // Event shape: lark-cli wraps the raw websocket event. Exact shape varies;
    // be defensive. In metadata mode we expect at minimum:
    //   { message_id, subject, from, attachments (array of {id, filename, content_type}) }
    // If shape differs, log and skip.

    const messageId: string | undefined = evt.message_id ?? evt.data?.message_id ?? evt.id
    if (!messageId) {
      log.warn(TAG, `[${sub.email}] event missing message_id, skipping: ${JSON.stringify(evt).slice(0, 300)}`)
      return
    }

    // Idempotency: skip if already processed
    if (this._processed.has(messageId)) {
      log.info(TAG, `[${sub.email}] message ${messageId} already processed, skipping`)
      return
    }

    const attachments: any[] = evt.attachments ?? evt.data?.attachments ?? []
    if (!Array.isArray(attachments) || attachments.length === 0) {
      log.info(TAG, `[${sub.email}] message ${messageId} has no attachments, skipping`)
      this._markProcessed(messageId) // mark to avoid re-processing on restart
      return
    }

    const subject: string = evt.subject ?? evt.data?.subject ?? ''
    const fromName: string = evt.head_from?.name ?? evt.data?.head_from?.name ?? sub.email
    const fromAddr: string = evt.head_from?.mail_address ?? evt.data?.head_from?.mail_address ?? ''

    log.info(TAG, `[${sub.email}] incoming mail ${messageId} subject="${subject}" from="${fromAddr}" attachments=${attachments.length}`)

    // Download all attachments (skill filters non-invoice downstream)
    const savedPaths: string[] = []
    const msgDir = join(this._inboxDir, sub.email, messageId)
    mkdirSync(msgDir, { recursive: true })

    for (const att of attachments) {
      const attId = att.id ?? att.attachment_id
      const filename = att.filename ?? `attachment-${attId}`
      if (!attId) continue
      try {
        const localPath = await this._downloadAttachment(sub.email, messageId, attId, filename, msgDir)
        if (localPath) savedPaths.push(localPath)
      } catch (e) {
        log.error(TAG, `[${sub.email}] download attachment ${attId} failed: ${e}`)
      }
    }

    if (savedPaths.length === 0) {
      log.warn(TAG, `[${sub.email}] ${messageId} no attachments downloaded, skipping`)
      return
    }

    // Build ParsedMessage — feed into dispatcher router
    const parsed = this._toParsedMessage(sub, messageId, subject, fromName, fromAddr, savedPaths)

    if (this._onMessage) {
      try {
        this._onMessage(parsed)
      } catch (e) {
        log.error(TAG, `[${sub.email}] onMessage handler threw: ${e}`)
      }
    }

    // Note: we do NOT mark as processed here. The skill in the worker will
    // mark it after successful ingestion. This means a crash between now
    // and ingestion will cause reprocessing (acceptable — dedup in bitable
    // prevents duplicate records).
  }

  private async _downloadAttachment(
    mailbox: string,
    messageId: string,
    attachmentId: string,
    filename: string,
    destDir: string,
  ): Promise<string | null> {
    // Step 1: get download URL via lark-cli
    const urlResp = await this._spawnJson([
      'mail', 'user_mailbox.message.attachments', 'download_url',
      '--params', JSON.stringify({
        user_mailbox_id: mailbox,
        message_id: messageId,
        attachment_ids: [attachmentId],
      }),
      '--as', 'user',
      '--format', 'json',
    ])

    const url = urlResp?.data?.download_urls?.[0]?.download_url
    if (!url) {
      log.warn(TAG, `no download_url for ${attachmentId}: ${JSON.stringify(urlResp).slice(0, 300)}`)
      return null
    }

    // Step 2: fetch URL
    const res = await fetch(url)
    if (!res.ok) {
      log.warn(TAG, `download ${attachmentId} failed: HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())

    const safeName = filename.replace(/[/\\]/g, '_')
    const localPath = join(destDir, safeName)
    writeFileSync(localPath, buf)
    log.info(TAG, `downloaded ${attachmentId} → ${localPath} (${(buf.length / 1024).toFixed(0)}KB)`)
    return localPath
  }

  private async _spawnJson(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const p = spawn(this._bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8') })
      p.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8') })
      p.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`lark-cli exited ${code}: ${err.slice(0, 400)}`))
          return
        }
        try {
          resolve(JSON.parse(out))
        } catch (e) {
          reject(new Error(`parse json failed: ${out.slice(0, 400)}`))
        }
      })
      p.on('error', reject)
    })
  }

  private _toParsedMessage(
    sub: MailSubscription,
    messageId: string,
    subject: string,
    fromName: string,
    fromAddr: string,
    savedPaths: string[],
  ): ParsedMessage {
    const atts: Attachment[] = savedPaths.map(p => ({
      type: 'file',
      fileName: p.split('/').pop() ?? p,
      localPath: p,
    }))

    // Pack mail context into message text so the skill can read it.
    const text = [
      `<mail-invoice>`,
      `<mailbox>${sub.email}</mailbox>`,
      `<owner-open-id>${sub.ownerOpenId}</owner-open-id>`,
      `<owner-name>${sub.ownerName ?? ''}</owner-name>`,
      `<message-id>${messageId}</message-id>`,
      `<subject>${subject.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</subject>`,
      `<from-name>${fromName.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</from-name>`,
      `<from-address>${fromAddr}</from-address>`,
      `<attachments>`,
      ...savedPaths.map(p => `  <file>${p}</file>`),
      `</attachments>`,
      `</mail-invoice>`,
      ``,
      `[收到来自 ${sub.email} 的邮件（主题：${subject}），附件已下载：${savedPaths.length} 个。请按 invoice-collector skill 的邮件分支处理。]`,
    ].join('\n')

    return {
      platform: 'mail',
      chatId: sub.email,               // use email as "chat id" for routing
      messageId,
      senderId: sub.ownerOpenId,       // owner is the "sender" from skill's perspective
      senderName: sub.ownerName ?? sub.email,
      text,
      chatType: 'private',
      mentionedBot: false,
      attachments: atts,
    }
  }

  private _loadProcessed(): void {
    try {
      if (existsSync(this._processedFile)) {
        const raw = readFileSync(this._processedFile, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this._processed = new Set(parsed)
        }
      }
    } catch (e) {
      log.warn(TAG, `failed to load processed file: ${e}`)
    }
  }

  private _markProcessed(messageId: string): void {
    if (this._processed.has(messageId)) return
    this._processed.add(messageId)
    try {
      writeFileSync(this._processedFile, JSON.stringify(Array.from(this._processed), null, 2))
    } catch (e) {
      log.warn(TAG, `failed to persist processed file: ${e}`)
    }
  }

  // ── Public helper: mark externally (e.g. after skill confirms ingestion) ──
  markProcessed(messageId: string): void {
    this._markProcessed(messageId)
  }
}
