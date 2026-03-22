/**
 * Streaming card lifecycle management for Lark.
 *
 * When Claude is processing a request, the daemon creates a streaming card
 * and updates it progressively with tool-use steps and text content.
 *
 * Lifecycle:
 *   1. Plugin POSTs /stream-event { type: 'start', convKey, chatId }
 *      → Daemon creates a streaming card entity via cardkit API and sends it
 *   2. Plugin POSTs /stream-event { type: 'tool_use', name, input }
 *      → Daemon inserts/appends a step in the collapsible panel
 *   3. Plugin POSTs /stream-event { type: 'text_delta', text }
 *      → Daemon updates the main markdown element with accumulated text
 *   4. Plugin POSTs /stream-event { type: 'done', text }
 *      → Daemon finalizes the card: removes loading indicator, closes streaming
 *
 * Pattern adapted from NeoClaw's sender.ts streaming card implementation.
 */

import type { LarkApi } from './gateways/lark/api.js'
import { log } from './utils/logger.js'

const TAG = 'streaming-card'

// ── Element IDs (must be unique within each card) ──

const EL = {
  stepsPanel: 'steps_panel',
  mainMd: 'main_md',
  loadingDiv: 'loading_div',
} as const

// ── Card state per conversation ──

export interface StreamingCardState {
  cardId: string
  chatId: string
  messageId: string
  replyToMessageId?: string
  sequence: number
  stepCount: number
  lastStepElementId: string | null
  hasPanelInserted: boolean
  accumulatedText: string
  createdAt: number
}

/** Active streaming cards, keyed by convKey. */
const cards = new Map<string, StreamingCardState>()

// ── Card JSON builders ──

function buildLoadingDiv(elementId: string): Record<string, unknown> {
  return {
    tag: 'div',
    element_id: elementId,
    icon: { tag: 'standard_icon', token: 'more_outlined', color: 'grey' },
    text: { tag: 'plain_text', text_color: 'grey', text_size: 'notation', content: '' },
  }
}

function buildStepDiv(text: string, iconToken: string, elementId: string): Record<string, unknown> {
  return {
    tag: 'div',
    element_id: elementId,
    icon: { tag: 'standard_icon', token: iconToken, color: 'grey' },
    text: { tag: 'plain_text', text_color: 'grey', text_size: 'notation', content: text },
  }
}

function buildStreamingCardJson(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 5 },
        print_strategy: 'delay',
      },
      enable_forward: true,
      width_mode: 'fill',
    },
    body: {
      elements: [
        { tag: 'markdown', element_id: EL.mainMd, content: '' },
        buildLoadingDiv(EL.loadingDiv),
      ],
    },
  }
}

// ── Tool step icon mapping ──

function toolIcon(name: string): string {
  const icons: Record<string, string> = {
    Bash: 'computer_outlined',
    Edit: 'edit_outlined',
    Glob: 'card-search_outlined',
    Grep: 'doc-search_outlined',
    Read: 'file-link-bitable_outlined',
    Write: 'edit_outlined',
    WebFetch: 'language_outlined',
    WebSearch: 'search_outlined',
    Agent: 'robot_outlined',
    Task: 'robot_outlined',
    Skill: 'file-link-mindnote_outlined',
    NotebookEdit: 'edit_outlined',
    TodoRead: 'list_outlined',
    TodoWrite: 'list_outlined',
  }
  return icons[name] ?? 'setting-inter_outlined'
}

function toolDescription(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return (inp.description as string) ?? (inp.command as string) ?? 'Run command'
    case 'Edit':
      return `Edit "${inp.file_path ?? ''}"`
    case 'Glob':
      return `Search files: "${inp.pattern ?? ''}"`
    case 'Grep':
      return `Search text: "${inp.pattern ?? ''}"`
    case 'Read':
      return `Read "${inp.file_path ?? ''}"`
    case 'Write':
      return `Write "${inp.file_path ?? ''}"`
    case 'WebFetch':
      return `Fetch "${inp.url ?? ''}"`
    case 'WebSearch':
      return `Search "${inp.query ?? ''}"`
    case 'Agent':
    case 'Task':
      return 'Run sub-agent'
    case 'Skill':
      return `Load skill "${inp.skill ?? ''}"`
    default:
      return name
  }
}

// ── Streaming card operations ──

export class StreamingCardManager {
  constructor(private api: LarkApi) {}

  /**
   * Start a new streaming card for a conversation.
   * Creates the card entity and sends it to the chat.
   */
  async start(convKey: string, chatId: string, replyToMessageId?: string): Promise<void> {
    // Clean up any existing card for this convKey
    if (cards.has(convKey)) {
      log.warn(TAG, `Replacing existing streaming card for ${convKey}`)
      await this.done(convKey, '').catch(() => {})
    }

    try {
      const cardJson = buildStreamingCardJson()
      const cardId = await this.api.createCardEntity(cardJson)
      const messageId = await this.api.sendCardByRef(chatId, cardId, { replyToMessageId })

      const state: StreamingCardState = {
        cardId,
        chatId,
        messageId,
        replyToMessageId,
        sequence: 1,
        stepCount: 0,
        lastStepElementId: null,
        hasPanelInserted: false,
        accumulatedText: '',
        createdAt: Date.now(),
      }

      cards.set(convKey, state)
      log.info(TAG, `Streaming card started: convKey=${convKey} cardId=${cardId}`)
    } catch (e) {
      log.error(TAG, `Failed to start streaming card for ${convKey}: ${e}`)
      throw e
    }
  }

  /**
   * Add a tool-use step to the streaming card.
   * Creates the steps panel on first call, appends subsequent steps.
   */
  async addToolStep(convKey: string, toolName: string, toolInput: unknown): Promise<void> {
    const state = cards.get(convKey)
    if (!state) {
      log.warn(TAG, `No streaming card for ${convKey}, ignoring tool step`)
      return
    }

    try {
      state.stepCount++
      const stepId = `step_${state.stepCount}`
      const text = toolDescription(toolName, toolInput)
      const icon = toolIcon(toolName)
      const stepDiv = buildStepDiv(text, icon, stepId)

      if (!state.hasPanelInserted) {
        // Insert the collapsible panel before the main markdown
        await this.api.insertCardElement(state.cardId, {
          type: 'insert_before',
          targetElementId: EL.mainMd,
          elements: [
            {
              tag: 'collapsible_panel',
              element_id: EL.stepsPanel,
              expanded: true,
              border: { color: 'grey-300', corner_radius: '6px' },
              vertical_spacing: '2px',
              header: {
                title: {
                  tag: 'plain_text',
                  text_color: 'grey',
                  text_size: 'notation',
                  content: 'Working on it',
                },
                icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
                icon_position: 'right',
                icon_expanded_angle: 90,
              },
              elements: [stepDiv],
            },
          ],
          sequence: state.sequence++,
        })
        state.hasPanelInserted = true
      } else {
        // Append after the last step element
        const afterId = state.lastStepElementId ?? EL.stepsPanel
        await this.api.insertCardElement(state.cardId, {
          type: 'insert_after',
          targetElementId: afterId,
          elements: [stepDiv],
          sequence: state.sequence++,
        })
      }

      state.lastStepElementId = stepId

      // Update panel header with step count
      await this.api.patchCardElement(state.cardId, EL.stepsPanel, {
        header: {
          title: {
            tag: 'plain_text',
            text_color: 'grey',
            text_size: 'notation',
            content: `Working on it (${state.stepCount} step${state.stepCount > 1 ? 's' : ''})`,
          },
          icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
          icon_position: 'right',
          icon_expanded_angle: 90,
        },
      }, state.sequence++)

      log.info(TAG, `Step added: ${convKey} → ${text}`)
    } catch (e) {
      log.error(TAG, `Failed to add tool step for ${convKey}: ${e}`)
    }
  }

  /**
   * Update the main text content (streaming typewriter effect).
   * Pass the FULL accumulated text — the platform computes the delta.
   */
  async updateText(convKey: string, text: string): Promise<void> {
    const state = cards.get(convKey)
    if (!state) return

    try {
      state.accumulatedText = text
      await this.api.updateCardElementContent(
        state.cardId,
        EL.mainMd,
        text,
        state.sequence++,
      )
    } catch (e) {
      log.error(TAG, `Failed to update text for ${convKey}: ${e}`)
    }
  }

  /**
   * Finalize the streaming card: set final text, collapse panel, remove
   * loading indicator, and close streaming mode.
   */
  async done(convKey: string, finalText?: string): Promise<void> {
    const state = cards.get(convKey)
    if (!state) return

    try {
      // Set final text if provided
      if (finalText !== undefined && finalText !== '') {
        await this.api.updateCardElementContent(
          state.cardId,
          EL.mainMd,
          finalText,
          state.sequence++,
        )
      }

      // Remove loading indicator
      try {
        await this.api.deleteCardElement(state.cardId, EL.loadingDiv, state.sequence++)
      } catch {
        // Loading div might already be removed
      }

      // Collapse the steps panel
      if (state.hasPanelInserted) {
        try {
          await this.api.patchCardElement(state.cardId, EL.stepsPanel, {
            expanded: false,
            header: {
              title: {
                tag: 'plain_text',
                text_color: 'grey',
                text_size: 'notation',
                content: `Completed (${state.stepCount} step${state.stepCount > 1 ? 's' : ''})`,
              },
              icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
              icon_position: 'right',
              icon_expanded_angle: 90,
            },
          }, state.sequence++)
        } catch {
          // Panel might not exist
        }
      }

      // Close streaming mode
      await this.api.closeCardStreaming(state.cardId, state.sequence++)

      log.info(TAG, `Streaming card finalized: ${convKey}`)
    } catch (e) {
      log.error(TAG, `Failed to finalize streaming card for ${convKey}: ${e}`)
    } finally {
      cards.delete(convKey)
    }
  }

  /**
   * Check if a streaming card exists for a conversation.
   */
  has(convKey: string): boolean {
    return cards.has(convKey)
  }

  /**
   * Get the state of a streaming card (for debugging).
   */
  getState(convKey: string): StreamingCardState | undefined {
    return cards.get(convKey)
  }
}
