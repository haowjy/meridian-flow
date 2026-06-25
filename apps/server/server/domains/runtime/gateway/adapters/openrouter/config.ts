/**
 * OpenRouter adapter configuration helpers shared by streaming and cancelled
 * settlement paths.
 */
import type { ProviderConfig } from "../../domain/index.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function resolveOpenRouterApiKey(auth: ProviderConfig["auth"]): string | undefined {
  if (!auth?.apiKey) return undefined;
  return typeof auth.apiKey === "function" ? auth.apiKey() : auth.apiKey;
}
