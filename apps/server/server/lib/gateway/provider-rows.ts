import {
  type BuiltinAdapter,
  DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
  DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
  type PromptCacheDescriptor,
} from "@meridian-flow/runtime/gateway";

/** Where a Flow-held fact came from and when someone last read it there. The refresh report flags one older than 90 days. */
export interface Provenance {
  source: string;
  /** ISO date. */
  checked: string;
}

/**
 * What models.dev lacks or Flow decides, per provider: the wire, the key, how the provider
 * caches, and the rates models.dev has no field for. Models and base prices come from
 * `models-snapshot.json`; which models, from `families.ts`.
 */
export interface ProviderRow {
  id: string;
  /** The provider's key in models.dev's api.json, where it differs from `id`. */
  modelsDevId: string;
  /** API wire format, mapping to ProviderConfig.adapter. */
  adapter: BuiltinAdapter;
  /** Environment variable that must contain a real key for this provider to enable. */
  apiKeyEnv: string;
  baseUrl?: string;
  /** Anthropic-format hosts that need Anthropic's tool-schema projection; the first-party API is the only one today. */
  projectToolSchema?: true;
  /** Lifetimes and kind; a field left out keeps the default in `resolvePromptCache`. */
  promptCache: { descriptor: Partial<PromptCacheDescriptor> } & Provenance;
  /**
   * The long-TTL cache-write rate (Anthropic 1h, OpenAI 12h) as a multiple of the input price.
   * models.dev lists only the short-TTL write price.
   */
  longCacheWrite?: { multiplier: number } & Provenance;
  /** Scales every rate models.dev lists, when it lists a rate Flow does not charge. */
  rateMultiplier?: { multiplier: number } & Provenance;
}

export const PROVIDER_ROWS: readonly ProviderRow[] = [
  {
    id: "anthropic",
    modelsDevId: "anthropic",
    adapter: "anthropic",
    apiKeyEnv: "FLOW_ANTHROPIC_API_KEY",
    projectToolSchema: true,
    // Explicit breakpoints, 5m and 1h. Claude bills cache writes by the TTL written: 5m at 1.25x
    // input (the models.dev price), 1h at 2x.
    promptCache: {
      descriptor: {
        kind: "explicit",
        shortTtlSeconds: DEFAULT_SUBAGENT_PROMPT_CACHE_TTL,
        longTtlSeconds: DEFAULT_PRIMARY_PROMPT_CACHE_TTL,
      },
      source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
      checked: "2026-11-05",
    },
    longCacheWrite: {
      multiplier: 2,
      source: "https://platform.claude.com/docs/en/about-claude/pricing",
      checked: "2026-11-05",
    },
  },
  {
    id: "openai",
    modelsDevId: "openai",
    adapter: "openai",
    apiKeyEnv: "FLOW_OPENAI_API_KEY",
    // GPT-5.6+ caches automatically: `prompt_cache_options.ttl` is "30m" (default) or "12h". A long
    // request takes the shortest option of at least 1 hour, which is 12h. Writes bill 1.25x input
    // for 30m (the models.dev price) and 2.5x for 12h.
    promptCache: {
      descriptor: { kind: "automatic", shortTtlSeconds: 30 * 60, longTtlSeconds: 12 * 60 * 60 },
      source: "https://developers.openai.com/api/docs/guides/prompt-caching",
      checked: "2026-11-05",
    },
    longCacheWrite: {
      multiplier: 2.5,
      source: "https://developers.openai.com/api/docs/pricing",
      checked: "2026-11-05",
    },
  },
  {
    id: "deepseek",
    modelsDevId: "deepseek",
    adapter: "anthropic",
    apiKeyEnv: "FLOW_DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/anthropic",
    // DeepSeek documents the cache as cleared "usually within a few hours to a few days". One hour
    // is the lower bound of that and an estimate; Flow sends no cache_control and has no lifetime
    // choice, so both chat kinds get it.
    promptCache: {
      descriptor: { kind: "automatic", shortTtlSeconds: 60 * 60, longTtlSeconds: 60 * 60 },
      source: "https://api-docs.deepseek.com/guides/kv_cache",
      checked: "2026-11-05",
    },
    // models.dev lists the off-peak rates; peak is double and Flow charges peak.
    rateMultiplier: {
      multiplier: 2,
      source: "https://api-docs.deepseek.com/quick_start/pricing",
      checked: "2026-11-05",
    },
  },
  {
    id: "gemini",
    modelsDevId: "google",
    adapter: "gemini",
    apiKeyEnv: "FLOW_GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com",
    // The Gemini API documents no lifetime for implicit caching, so prediction reads it as cold.
    // Implicit cache only: no write fee.
    promptCache: {
      descriptor: { kind: "automatic", shortTtlSeconds: null, longTtlSeconds: null },
      source: "https://ai.google.dev/gemini-api/docs/caching",
      checked: "2026-11-05",
    },
  },
];
