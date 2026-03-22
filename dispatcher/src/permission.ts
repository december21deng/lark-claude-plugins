/**
 * Permission prompt forwarding to Lark.
 *
 * When Claude CLI needs permission to use a tool, the plugin sends a
 * `permission_prompt` tool-call to the daemon. The daemon:
 *   1. Sends an interactive card with Allow / Deny buttons to the Lark chat
 *   2. Waits for the user to click a button (card.action.trigger_v1)
 *   3. Returns the user's choice to the plugin
 *
 * A fallback is provided: if the user replies with text ("允许"/"拒绝") instead
 * of clicking a button, the text-based response is also accepted.
 */

import { log } from './utils/logger.js'

const TAG = 'permission'

// ── Pending permission requests ──

export interface PendingPermission {
  convKey: string
  chatId: string
  question: string
  toolName: string
  cardMessageId?: string
  resolve: (allowed: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

/** Map from a unique request key → pending permission. */
const pending = new Map<string, PendingPermission>()

// ── Card builder ──

/**
 * Build an interactive card with Allow/Deny buttons for a permission prompt.
 * Uses Card JSON 2.0 with callback behaviors on buttons.
 */
export function buildPermissionCard(opts: {
  question: string
  toolName: string
  requestId: string
}): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `**🔒 权限请求**\n\nClaude 想要使用工具：**${opts.toolName}**\n\n${opts.question}`,
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 允许' },
              type: 'primary',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    _permission_action: 'allow',
                    _permission_request_id: opts.requestId,
                  },
                },
              ],
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'danger',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    _permission_action: 'deny',
                    _permission_request_id: opts.requestId,
                  },
                },
              ],
            },
          ],
        },
        {
          tag: 'markdown',
          content: '*也可以直接回复 "允许" 或 "拒绝"*',
        },
      ],
    },
  }
}

// ── Request management ──

const TIMEOUT_MS = 120_000 // 2 minutes

/**
 * Register a pending permission request.
 * Returns a promise that resolves with the user's decision (true = allow).
 */
export function createPermissionRequest(opts: {
  requestId: string
  convKey: string
  chatId: string
  question: string
  toolName: string
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      log.warn(TAG, `Permission request ${opts.requestId} timed out, denying`)
      pending.delete(opts.requestId)
      resolve(false)
    }, TIMEOUT_MS)

    pending.set(opts.requestId, {
      convKey: opts.convKey,
      chatId: opts.chatId,
      question: opts.question,
      toolName: opts.toolName,
      resolve,
      timeout,
    })
  })
}

/**
 * Resolve a pending permission request by its requestId.
 * Called when a card button is clicked or a text reply is received.
 * Returns true if a pending request was found and resolved.
 */
export function resolvePermission(requestId: string, allowed: boolean): boolean {
  const req = pending.get(requestId)
  if (!req) return false

  clearTimeout(req.timeout)
  pending.delete(requestId)
  log.info(TAG, `Permission ${requestId} resolved: ${allowed ? 'ALLOW' : 'DENY'}`)
  req.resolve(allowed)
  return true
}

/**
 * Handle a card action callback for permission buttons.
 * Returns true if this callback was a permission action (handled).
 */
export function handleCardAction(data: Record<string, unknown>): boolean {
  // The action value is nested inside data.action.value
  const action = data.action as Record<string, unknown> | undefined
  const value = action?.value as Record<string, unknown> | undefined

  if (!value || !value._permission_action || !value._permission_request_id) {
    return false
  }

  const requestId = value._permission_request_id as string
  const allowed = value._permission_action === 'allow'

  log.info(TAG, `Card action for permission ${requestId}: ${allowed ? 'allow' : 'deny'}`)
  return resolvePermission(requestId, allowed)
}

/**
 * Try to resolve a permission from a text message in the same chat.
 * Checks if there's a pending permission for the given convKey and
 * the text matches "允许"/"拒绝" or "allow"/"deny".
 * Returns true if a permission was resolved.
 */
export function tryResolveFromText(convKey: string, text: string): boolean {
  const trimmed = text.trim().toLowerCase()

  let allowed: boolean | null = null
  if (['允许', 'allow', 'yes', '是', 'y'].includes(trimmed)) {
    allowed = true
  } else if (['拒绝', 'deny', 'no', '否', 'n', '不'].includes(trimmed)) {
    allowed = false
  }

  if (allowed === null) return false

  // Find a pending permission for this convKey
  for (const [requestId, req] of pending) {
    if (req.convKey === convKey) {
      log.info(TAG, `Text-based permission resolution for ${requestId}: ${allowed ? 'allow' : 'deny'}`)
      return resolvePermission(requestId, allowed)
    }
  }

  return false
}

/**
 * Set the card message ID for a pending request (for reference/cleanup).
 */
export function setCardMessageId(requestId: string, messageId: string): void {
  const req = pending.get(requestId)
  if (req) req.cardMessageId = messageId
}

/**
 * Get the count of pending permission requests.
 */
export function pendingCount(): number {
  return pending.size
}
