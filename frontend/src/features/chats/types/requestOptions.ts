import type { RequestParams } from './chat'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface ChatRequestOptions {
  modelId: string
  modelLabel: string
  providerId: string
  reasoning: ReasoningLevel
  // Note: tools are NOT user-configurable here - always uses DEFAULT_TOOLS
  // Future: add disabledTools: string[] for opt-out of specific tools
}

export const DEFAULT_TOOLS = [
  { name: 'doc_view' },
  { name: 'doc_search' },
  { name: 'doc_tree' },
  { name: 'doc_edit' },
  { name: 'tavily_web_search' },
]

export const DEFAULT_CHAT_REQUEST_OPTIONS: ChatRequestOptions = {
  modelId: 'moonshotai/kimi-k2-thinking',
  modelLabel: 'Kimi K2 Thinking',
  providerId: 'openrouter',
  reasoning: 'low', // Default model (kimi-k2-thinking) requires thinking
}

/**
 * Converts backend RequestParams to frontend ChatRequestOptions.
 * Falls back to defaults for missing fields.
 */
export function requestParamsToOptions(params?: RequestParams | null): ChatRequestOptions {
  if (!params) return { ...DEFAULT_CHAT_REQUEST_OPTIONS }

  // Map thinking_level to reasoning, defaulting to 'low' if thinking is enabled but no level set
  let reasoning: ReasoningLevel = 'off'
  if (params.thinking_enabled || params.thinking_level) {
    reasoning = (params.thinking_level as ReasoningLevel) ?? 'low'
  }

  return {
    modelId: params.model ?? DEFAULT_CHAT_REQUEST_OPTIONS.modelId,
    modelLabel: params.model ?? DEFAULT_CHAT_REQUEST_OPTIONS.modelLabel, // Will be overwritten by ChatRequestControls if needed
    providerId: params.provider ?? DEFAULT_CHAT_REQUEST_OPTIONS.providerId,
    reasoning,
    // Note: tools not included - always uses DEFAULT_TOOLS via api.ts
  }
}
