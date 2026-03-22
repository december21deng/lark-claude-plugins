import type { ParsedMessage, FeishuConfig } from '../../types.js'
import { markSeen } from '../../utils/dedup.js'
import { log } from '../../utils/logger.js'

const TAG = 'feishu-recv'

// ── Message text extraction ──

function extractText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (msgType === 'text') return (parsed['text'] as string) || ''
    if (msgType === 'post') return extractRichText(content)
    return content
  } catch { return content }
}

function extractRichText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string
      content?: Array<Array<{
        tag: string; text?: string; href?: string
        user_id?: string; user_name?: string
        language?: string; style?: string[]
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
  config: FeishuConfig
): GateResult {
  const access = config.access

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

  const rawText = extractText(
    event.message.content ?? '{}',
    event.message.message_type ?? 'text'
  )

  // Build content
  let text = rawText
  if (!text) text = '(attachment)'

  log.info(TAG, `msg=${msgId} chat=${chatId} type=${chatType} sender=${senderId} mentioned=${mentionedBot}`)

  return {
    platform: 'feishu',
    chatId,
    messageId: msgId,
    threadId,
    senderId,
    senderName: senderId, // We don't have display name from event
    text,
    chatType,
    mentionedBot,
  }
}
