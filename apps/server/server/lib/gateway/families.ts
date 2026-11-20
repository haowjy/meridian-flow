import { resolveAlias } from "@meridian-flow/mars-schema";

/**
 * One allowlisted family of models in a provider's models.dev catalog, shaped like the
 * `[models.<family>]` tables in meridian-base's mars.toml. A model is offered when its id
 * matches `match` and not `exclude` (`*` is the only wildcard), so a new version in a family
 * appears at the next snapshot refresh without a code change. Every other fact about a model is
 * data in `model-data.json`.
 */
export interface ModelFamily {
  id: string;
  match: readonly string[];
  exclude?: readonly string[];
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
      match: ["claude-opus-*"],
      exclude: ["claude-opus-4*", "claude-opus-5"],
    },
    {
      id: "sonnet",
      match: ["claude-sonnet-*"],
      exclude: ["claude-sonnet-4*", "claude-sonnet-5"],
    },
    {
      id: "fable",
      match: ["claude-fable-*"],
      exclude: ["claude-fable-5"],
    },
  ],
  openai: [
    {
      id: "sol",
      match: ["gpt-*-sol"],
      exclude: ["gpt-6-sol", "gpt-5.6-sol"],
    },
    {
      id: "terra",
      match: ["gpt-*-terra"],
      exclude: ["gpt-5.6-terra"],
    },
    { id: "luna", match: ["gpt-*-luna"] },
  ],
  deepseek: [{ id: "deepseek", match: ["deepseek-flash*"] }],
  deepinfra: [{ id: "deepseek-test", match: ["deepseek-ai/DeepSeek-V4.1-Flash-1017"] }],
  gemini: [
    { id: "argon", match: ["gemini-4-argon*"] },
    { id: "hydrogen", match: ["gemini-4-hydrogen*"] },
  ],
};

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
