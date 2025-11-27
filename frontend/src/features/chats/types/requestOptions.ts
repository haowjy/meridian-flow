export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high'

export interface ChatRequestOptions {
  modelId: string
  modelLabel: string
  providerId: string
  reasoning: ReasoningLevel
  searchEnabled: boolean
}

export const DEFAULT_CHAT_REQUEST_OPTIONS: ChatRequestOptions = {
  modelId: 'moonshotai/kimi-k2-thinking',
  modelLabel: 'Kimi K2 Thinking',
  providerId: 'openrouter',
  reasoning: 'off',
  searchEnabled: false,
}
