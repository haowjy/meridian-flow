/**
 * OpenRouter generation metadata client: fetches authoritative cost and
 * provider-native token stats from GET /generation after a chat completion
 * finishes. Native counters remain provider metadata because OpenRouter does
 * not define whether cached tokens are included in the prompt total.
 */
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

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

function resolveGenerationUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return new URL(`${normalized}/generation`);
}

export async function fetchOpenRouterGeneration(
  generationId: string,
  apiKey: string,
  baseUrl: string = DEFAULT_BASE_URL,
  signal?: AbortSignal,
): Promise<OpenRouterGenerationRecord | null> {
  const url = resolveGenerationUrl(baseUrl);
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
