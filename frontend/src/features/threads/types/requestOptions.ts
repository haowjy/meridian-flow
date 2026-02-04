import type { RequestParams } from './thread'

export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface ThreadRequestOptions {
  modelId: string
  modelLabel: string
  providerId: string
  reasoning: ReasoningLevel
  /** Whether the selected model supports tool calling (doc_edit, doc_view, etc.) */
  supportsTools: boolean
}

export const DEFAULT_TOOLS = [
  { name: 'str_replace_based_edit_tool' },
  { name: 'doc_search' },
  { name: 'doc_tree' },
  { name: 'tavily_web_search' },
]

export const DEFAULT_THREAD_REQUEST_OPTIONS: ThreadRequestOptions = {
  modelId: 'moonshotai/kimi-k2-thinking',
  modelLabel: 'Kimi K2 Thinking',
  providerId: 'openrouter',
  reasoning: 'low', // Default model (kimi-k2-thinking) requires thinking
  supportsTools: true, // Default model supports tools
}

/**
 * Converts backend RequestParams to frontend ThreadRequestOptions.
 * Falls back to defaults for missing fields.
 *
 * Note: RequestParams uses camelCase because fetchAPI's convertKeysToCamelCase
 * transforms all keys from the backend's snake_case (thinking_enabled -> thinkingEnabled).
 */
export function requestParamsToOptions(params?: RequestParams | null): ThreadRequestOptions {
  if (!params) return { ...DEFAULT_THREAD_REQUEST_OPTIONS }

  // Map thinkingLevel to reasoning, defaulting to 'low' if thinking is enabled but no level set
  let reasoning: ReasoningLevel = 'off'
  if (params.thinkingEnabled || params.thinkingLevel) {
    reasoning = (params.thinkingLevel as ReasoningLevel) ?? 'low'
  }

  return {
    modelId: params.model ?? DEFAULT_THREAD_REQUEST_OPTIONS.modelId,
    modelLabel: params.model ?? DEFAULT_THREAD_REQUEST_OPTIONS.modelLabel, // Will be overwritten by ThreadRequestControls if needed
    providerId: params.provider ?? DEFAULT_THREAD_REQUEST_OPTIONS.providerId,
    reasoning,
    // Default to true - will be corrected when model capabilities are loaded
    supportsTools: DEFAULT_THREAD_REQUEST_OPTIONS.supportsTools,
  }
}
