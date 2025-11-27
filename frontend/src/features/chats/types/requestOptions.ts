export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface ChatRequestOptions {
  modelId: string
  modelLabel: string
  providerId: string
  reasoning: ReasoningLevel
  tools?: Array<{ name: string }>
}

export const DEFAULT_TOOLS = [
  { name: 'doc_view' },
  { name: 'doc_search' },
  { name: 'doc_tree' },
  { name: 'tavily_web_search' },
]

export const DEFAULT_CHAT_REQUEST_OPTIONS: ChatRequestOptions = {
  modelId: 'moonshotai/kimi-k2-thinking',
  modelLabel: 'Kimi K2 Thinking',
  providerId: 'openrouter',
  reasoning: 'low', // Default model (kimi-k2-thinking) requires thinking
}
