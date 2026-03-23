import type { ParsedMessage, LarkConfig, AccessConfig, Attachment } from '../../types.js'
import { markSeen } from '../../utils/dedup.js'
import { log } from '../../utils/logger.js'

const TAG = 'lark-recv'

// ── Message text extraction ──

function extractText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (msgType === 'text') return (parsed['text'] as string) || ''
    if (msgType === 'post') return extractRichText(content)
    return content
  } catch { return content }
}

/** Extract image/file keys from message content based on msg_type */
function extractAttachments(content: string, msgType: string): Attachment[] {
  try {
    const p = JSON.parse(content) as Record<string, unknown>
    switch (msgType) {
      case 'image':
        return p['image_key'] ? [{ type: 'image', imageKey: p['image_key'] as string }] : []
      case 'file':
        return p['file_key'] ? [{ type: 'file', fileKey: p['file_key'] as string, fileName: p['file_name'] as string }] : []
      case 'post':
        return extractRichTextImages(content)
      default:
        return []
    }
  } catch { return [] }
}

/** Extract image_key entries from rich text (post) content */
function extractRichTextImages(content: string): Attachment[] {
  try {
    const parsed = JSON.parse(content) as {
      content?: Array<Array<{ tag: string; image_key?: string }>>
    }
    const attachments: Attachment[] = []
    for (const para of parsed.content ?? []) {
      for (const el of para) {
        if (el.tag === 'img' && el.image_key) {
          attachments.push({ type: 'image', imageKey: el.image_key })
        }
      }
    }
    return attachments
  } catch { return [] }
}

function extractRichText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string
      content?: Array<Array<{
        tag: string; text?: string; href?: string
        user_id?: string; user_name?: string
        language?: string; image_key?: string; style?: string[]
      }>>
    }
    let text = parsed.title ? `# ${parsed.title}\n\n` : ''
    for (const para of parsed.content ?? []) {
      for (const el of para) {
        const styles = el.style ?? []
        if (el.tag === 'text') text += applyStyles(el.text ?? '', styles)
        else if (el.tag === 'code_block') text += `\`\`\`${el.language ?? ''}\n${el.text ?? ''}\`\`\``
        else if (el.tag === 'a') text += `[${el.text ?? el.href ?? ''}](${el.href ?? ''})`
        else if (el.tag === 'at') text += el.user_name ? `@${el.user_name}` : (el.user_id ?? '')
        else if (el.tag === 'img') text += '[图片]'
      }
      text += '\n'
    }
    return text.trim() || '[富文本消息]'
  } catch { return '[富文本消息]' }
}

function applyStyles(text: string, styles: string[]): string {
  if (!text || !styles.length) return text
  let r = text
  if (styles.includes('bold')) r = `**${r}**`
  if (styles.includes('italic')) r = `*${r}*`
  if (styles.includes('underline')) r = `<u>${r}</u>`
  if (styles.includes('lineThrough')) r = `~~${r}~~`
  return r
}

// ── Mention placeholder replacement ──

/**
 * Replace @_user_N placeholders with real user names and open_ids.
 * Feishu text messages contain placeholders like "@_user_1" which map to
 * entries in the mentions array: { key: "@_user_1", id: { open_id: "ou_xxx" }, name: "温昕昕" }
 */
function replaceMentionPlaceholders(text: string, mentions?: any[]): string {
  if (!mentions?.length || !text) return text
  let result = text
  for (const m of mentions) {
    const key = m.key as string | undefined   // e.g. "@_user_1"
    const name = m.name as string | undefined  // e.g. "温昕昕"
    const openId = m.id?.open_id as string | undefined
    if (!key) continue
    const replacement = name
      ? (openId ? `@${name}(${openId})` : `@${name}`)
      : (openId ?? key)
    result = result.replace(key, replacement)
  }
  return result
}

// ── Bot mention detection ──

function isBotMentioned(event: any, botOpenId?: string): boolean {
  if (!botOpenId) return false
  return (event.message?.mentions ?? []).some((m: any) => m.id?.open_id === botOpenId)
}

// ── Access control (gate) ──

type GateResult =
  | { action: 'allow' }
  | { action: 'drop' }
  | { action: 'pair'; code: string }

export function gate(
  chatId: string,
  chatType: 'private' | 'group',
  senderId: string,
  mentionedBot: boolean,
  access: AccessConfig,
): GateResult {
  if (chatType === 'private') {
    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    if (access.dmPolicy === 'open') return { action: 'allow' }
    if (access.allowFrom.includes(senderId)) return { action: 'allow' }
    if (access.dmPolicy === 'pairing') {
      const code = Math.random().toString(16).slice(2, 8)
      return { action: 'pair', code }
    }
    return { action: 'drop' }
  }

  // Group chat
  const isAutoReply = access.groupAutoReply.includes(chatId)
  const groupCfg = access.groups[chatId]

  if (!isAutoReply && !groupCfg) return { action: 'drop' }
  if (!isAutoReply && groupCfg?.requireMention && !mentionedBot) return { action: 'drop' }
  if (groupCfg?.allowFrom?.length && !groupCfg.allowFrom.includes(senderId)) return { action: 'drop' }

  return { action: 'allow' }
}

// ── Parse raw event into ParsedMessage ──

export function parseEvent(event: any, botOpenId?: string): ParsedMessage | null {
  const msgId = event?.message?.message_id
  if (!msgId) return null
  if (event.sender?.sender_type === 'bot') return null
  if (!markSeen(msgId)) return null

  const chatId = event.message.chat_id as string
  const rawChatType = event.message.chat_type as string
  const chatType: 'private' | 'group' = rawChatType === 'p2p' ? 'private' : 'group'
  const senderId = event.sender?.sender_id?.open_id ?? ''
  const threadId = event.message.thread_id as string | undefined
  const mentionedBot = isBotMentioned(event, botOpenId)

  const msgType = event.message.message_type ?? 'text'
  const rawContent = event.message.content ?? '{}'

  const rawText = extractText(rawContent, msgType)
  const attachments = extractAttachments(rawContent, msgType)

  // Replace @_user_N placeholders with real names + open_id
  let text = replaceMentionPlaceholders(rawText, event.message?.mentions)

  if (!text && attachments.length) text = `[${msgType} message]`
  else if (!text) text = '(attachment)'

  log.info(TAG, `msg=${msgId} chat=${chatId} type=${chatType} sender=${senderId} mentioned=${mentionedBot} attachments=${attachments.length}`)

  return {
    platform: 'lark',
    chatId,
    messageId: msgId,
    threadId,
    senderId,
    senderName: senderId, // We don't have display name from event
    text,
    chatType,
    mentionedBot,
    ...(attachments.length ? { attachments } : {}),
  }
}
