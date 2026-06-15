/**
 * OpenRouter generation metadata client: fetches authoritative cost and token
 * stats from GET /api/v1/generation after a chat completion finishes. Used when
 * the streaming usage chunk omits cost (interrupted streams, older models).
 */
export interface OpenRouterGenerationRecord {
  id: string;
  total_cost: number;
  native_tokens_prompt?: number;
  native_tokens_completion?: number;
  native_tokens_reasoning?: number;
  native_tokens_cached?: number;
  cancelled?: boolean;
}

interface GenerationResponse {
  data?: OpenRouterGenerationRecord;
}

export async function fetchOpenRouterGeneration(
  generationId: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<OpenRouterGenerationRecord | null> {
  const url = new URL("https://openrouter.ai/api/v1/generation");
  url.searchParams.set("id", generationId);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) return null;

  const body = (await response.json()) as GenerationResponse;
  const record = body.data;
  if (!record || typeof record.total_cost !== "number") return null;
  return record;
}
