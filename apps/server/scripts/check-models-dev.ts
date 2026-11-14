/**
 * Compares the model registry's facts with https://models.dev/api.json and exits 1 on drift.
 * Needs the network, so it is `pnpm check:models`, not part of `pnpm check`; the server never
 * fetches models.dev at run time.
 */
import { MODEL_REGISTRY } from "../server/lib/gateway/registry.js";

/** Registry provider id → models.dev provider id, where they differ. */
const MODELS_DEV_PROVIDER: Record<string, string> = { gemini: "google" };

interface ModelsDevModel {
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
}

const response = await fetch("https://models.dev/api.json");
if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
const catalog = (await response.json()) as Record<
  string,
  { models?: Record<string, ModelsDevModel> }
>;

const drift: string[] = [];
for (const provider of MODEL_REGISTRY.providers) {
  const providerId = MODELS_DEV_PROVIDER[provider.id] ?? provider.id;
  for (const { model } of provider.offerings) {
    const row = catalog[providerId]?.models?.[model.id];
    if (!row) {
      drift.push(`${provider.id}/${model.id}: not in models.dev under ${providerId}`);
      continue;
    }
    const modalities = [...(row.modalities?.input ?? [])].sort().join(",");
    const ours = [...model.inputModalities].sort().join(",");
    if (modalities !== ours) {
      drift.push(
        `${provider.id}/${model.id}: input modalities ${ours} here, ${modalities} on models.dev`,
      );
    }
    if (row.limit?.context !== model.contextWindow) {
      drift.push(
        `${provider.id}/${model.id}: context ${model.contextWindow} here, ${row.limit?.context} on models.dev`,
      );
    }
    if (row.limit?.output !== model.maxOutputTokens) {
      drift.push(
        `${provider.id}/${model.id}: max output ${model.maxOutputTokens} here, ${row.limit?.output} on models.dev`,
      );
    }
  }
}

if (drift.length > 0) {
  console.error(`Registry drifts from models.dev:\n${drift.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("Registry matches models.dev (input modalities, context window, max output).");
