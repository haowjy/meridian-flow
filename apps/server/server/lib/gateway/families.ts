import type { ModelMaker } from "@meridian/contracts/protocol";
import { resolveAlias } from "@meridian-flow/mars-schema";
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
  /** Who made the model, whoever serves it. */
  maker: ModelMaker;
  tokenizer: TokenizerFamily;
  /** Largest file, in bytes, the provider fetches by link, where its docs state one. */
  maxLinkBytes?: number;
  /** The model thinks unless told not to; models.dev does not say. */
  thinksByDefault?: true;
}

/**
 * Keyed by Flow's provider id. A family id is its alias in meridian-base's mars.toml: the
 * picker shows it and an Agent file's `model` may name it. Nothing checks the two agree; keep
 * them equal by hand. The `exclude` entries are dated,
 * deprecated and older-generation ids that models.dev lists and Flow does not offer; delete
 * one to offer that model at the next refresh. Offerings keep this family order.
 */
export const MODEL_FAMILIES: Readonly<Record<string, readonly ModelFamily[]>> = {
  anthropic: [
    {
      id: "opus",
      maker: "anthropic",
      match: ["claude-opus-*"],
      exclude: ["claude-opus-4*", "claude-opus-5"],
      tokenizer: "anthropic",
    },
    {
      id: "sonnet",
      maker: "anthropic",
      match: ["claude-sonnet-*"],
      exclude: ["claude-sonnet-4*", "claude-sonnet-5"],
      tokenizer: "anthropic",
    },
    {
      id: "fable",
      maker: "anthropic",
      match: ["claude-fable-*"],
      exclude: ["claude-fable-5"],
      tokenizer: "anthropic",
    },
  ],
  // OpenAI has not published the GPT-6 / GPT-5.6 tokenizer; o200k is the estimate.
  openai: [
    {
      id: "sol",
      maker: "openai",
      match: ["gpt-*-sol"],
      exclude: ["gpt-6-sol", "gpt-5.6-sol"],
      tokenizer: "o200k",
    },
    {
      id: "terra",
      maker: "openai",
      match: ["gpt-*-terra"],
      exclude: ["gpt-5.6-terra"],
      tokenizer: "o200k",
    },
    { id: "luna", maker: "openai", match: ["gpt-*-luna"], tokenizer: "o200k" },
  ],
  deepseek: [
    {
      id: "deepseek",
      maker: "deepseek",
      match: ["deepseek-flash*"],
      tokenizer: "deepseek",
      thinksByDefault: true,
    },
  ],
  gemini: [
    {
      id: "argon",
      maker: "google",
      match: ["gemini-4-argon*"],
      tokenizer: "gemini",
      // Gemini fetches a link up to 15 MB (ai.google.dev file-input docs).
      maxLinkBytes: 15_000_000,
    },
    {
      id: "hydrogen",
      maker: "google",
      match: ["gemini-4-hydrogen*"],
      tokenizer: "gemini",
      maxLinkBytes: 15_000_000,
    },
  ],
};

/** Model ID used when callers omit a model; the registry fails to build when the snapshot lacks it. */
export const DEFAULT_MODEL_ID = "deepseek-flash";

/**
 * The newest of `rows` that `family` admits, by Mars's alias rule (`resolveAlias` in
 * `@meridian-flow/mars-schema`), or null when it admits none.
 */
export function newestInFamily(
  family: ModelFamily,
  rows: { id: string; provider: string; release_date?: string }[],
): string | null {
  return resolveAlias(rows, { match: [...family.match], exclude: [...(family.exclude ?? [])] });
}

/** The first family of a provider that admits this models.dev id, or undefined. */
export function findFamily(providerId: string, modelId: string): ModelFamily | undefined {
  return MODEL_FAMILIES[providerId]?.find(
    (family) => newestInFamily(family, [{ id: modelId, provider: providerId }]) !== null,
  );
}
