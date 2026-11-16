import type { TokenizerFamily } from "@meridian-flow/runtime/gateway";

/**
 * One allowlisted family of models in a provider's models.dev catalog, shaped like the
 * `[models.<family>]` tables in meridian-base's mars.toml. A model is offered when its id
 * matches `match` and not `exclude` (`*` is the only wildcard), so a new version in a family
 * appears at the next snapshot refresh without a code change.
 */
export interface ModelFamily {
  id: string;
  match: readonly string[];
  exclude?: readonly string[];
  tokenizer: TokenizerFamily;
  /** Largest file, in bytes, the provider fetches by link, where its docs state one. */
  maxLinkBytes?: number;
  /** The model thinks unless told not to; models.dev does not say. */
  thinksByDefault?: true;
}

/**
 * Keyed by Flow's provider id. The `exclude` entries are versions models.dev lists that Flow
 * has chosen not to offer (older siblings, and newer ones nobody has picked up yet); delete
 * one to offer that model at the next refresh. Offerings keep this family order.
 */
export const MODEL_FAMILIES: Readonly<Record<string, readonly ModelFamily[]>> = {
  anthropic: [
    {
      id: "opus",
      match: ["claude-opus-*"],
      exclude: ["claude-opus-4*", "claude-opus-5"],
      tokenizer: "anthropic",
    },
    {
      id: "sonnet",
      match: ["claude-sonnet-*"],
      exclude: ["claude-sonnet-4*", "claude-sonnet-5"],
      tokenizer: "anthropic",
    },
    {
      id: "fable",
      match: ["claude-fable-*"],
      exclude: ["claude-fable-5", "claude-fable-5-2"],
      tokenizer: "anthropic",
    },
  ],
  // OpenAI has not published the GPT-6 / GPT-5.6 tokenizer; o200k is the estimate.
  openai: [
    { id: "sol", match: ["gpt-*-sol"], exclude: ["gpt-6-sol", "gpt-5.6-sol"], tokenizer: "o200k" },
    { id: "terra", match: ["gpt-*-terra"], exclude: ["gpt-5.6-terra"], tokenizer: "o200k" },
    { id: "luna", match: ["gpt-*-luna"], exclude: ["gpt-6-luna"], tokenizer: "o200k" },
  ],
  deepseek: [
    { id: "flash", match: ["deepseek-flash*"], tokenizer: "deepseek", thinksByDefault: true },
  ],
  gemini: [
    {
      id: "argon",
      match: ["gemini-4-argon*"],
      tokenizer: "gemini",
      // Gemini fetches a link up to 15 MB (ai.google.dev file-input docs).
      maxLinkBytes: 15_000_000,
    },
  ],
};

/** Model ID used when callers omit a model; the registry fails to build when the snapshot lacks it. */
export const DEFAULT_MODEL_ID = "deepseek-flash";

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/** The first family of a provider that admits this models.dev id, or undefined. */
export function findFamily(providerId: string, modelId: string): ModelFamily | undefined {
  return MODEL_FAMILIES[providerId]?.find(
    (family) =>
      family.match.some((glob) => globToRegExp(glob).test(modelId)) &&
      !(family.exclude ?? []).some((glob) => globToRegExp(glob).test(modelId)),
  );
}
