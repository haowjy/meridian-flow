import { resolveAlias } from "@meridian-flow/mars-schema";

export interface ModelFamily {
  id: string;
  match: readonly string[];
  exclude?: readonly string[];
}

// keep: a family id must equal its alias in meridian-base's mars.toml and nothing checks that the two agree
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

export function newestInFamily(
  family: ModelFamily,
  rows: { id: string; provider: string; release_date?: string }[],
): string | null {
  return resolveAlias(rows, { match: [...family.match], exclude: [...(family.exclude ?? [])] });
}

export function findFamily(providerId: string, modelId: string): ModelFamily | undefined {
  return MODEL_FAMILIES[providerId]?.find(
    (family) => newestInFamily(family, [{ id: modelId, provider: providerId }]) !== null,
  );
}
