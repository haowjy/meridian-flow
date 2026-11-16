/**
 * `pnpm models:refresh`: rewrites `models-snapshot.json` from https://models.dev/api.json and
 * prints what changed. Billing charges the committed snapshot, never live data, so a person
 * reviews this report and commits the snapshot in a PR. Needs the network, so it is outside
 * `pnpm check`; the daily `models-refresh` workflow runs it and files the report as an issue.
 *
 *   --api <url|path>      read the catalog from here instead of models.dev
 *   --dry-run             print the report and leave the snapshot as it is
 *   --report-file <path>  also write the report there, only when something changed
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findFamily } from "../server/lib/gateway/families.js";
import { PROVIDER_ROWS } from "../server/lib/gateway/provider-rows.js";
import {
  buildModelRegistry,
  type ModelRegistry,
  type ModelsSnapshot,
  type SnapshotModel,
} from "../server/lib/gateway/registry.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("../server/lib/gateway/models-snapshot.json", import.meta.url),
);
const RECHECK_AFTER_DAYS = 90;
// GitHub rejects an issue body past 65,536 characters.
const MAX_REPORT_CHARS = 60_000;

const { values: args } = parseArgs({
  options: {
    api: { type: "string", default: "https://models.dev/api.json" },
    "dry-run": { type: "boolean", default: false },
    "report-file": { type: "string" },
  },
});

interface CatalogModel extends SnapshotModel {
  status?: string;
}
type Catalog = Record<string, { models?: Record<string, CatalogModel> }>;

async function loadCatalog(source: string): Promise<Catalog> {
  if (!/^https?:\/\//.test(source)) return JSON.parse(readFileSync(source, "utf8"));
  const response = await fetch(source);
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
  return (await response.json()) as Catalog;
}

/** Only the fields Flow reads, so an unrelated models.dev edit leaves the snapshot alone. */
function pick(model: CatalogModel): SnapshotModel {
  const { cost } = model;
  return {
    name: model.name,
    tool_call: model.tool_call,
    limit: { context: model.limit.context, output: model.limit.output },
    modalities: { input: model.modalities.input },
    reasoning_options: model.reasoning_options ?? [],
    cost: {
      input: cost.input,
      output: cost.output,
      cache_read: cost.cache_read,
      cache_write: cost.cache_write,
      tiers: cost.tiers,
    },
  };
}

function offeredModels(catalog: Catalog): ModelsSnapshot["providers"] {
  return Object.fromEntries(
    PROVIDER_ROWS.map((row) => {
      const models = catalog[row.modelsDevId]?.models ?? {};
      const offered = Object.keys(models)
        .sort()
        .filter((id) => models[id].status !== "deprecated" && findFamily(row.id, id))
        .map((id) => [id, pick(models[id])]);
      return [row.id, Object.fromEntries(offered)];
    }),
  );
}

type Fields = Map<string, string>;

/** Every fact the registry holds about one offering, as `path → text`. */
function offeringFields(registry: ModelRegistry): Map<string, Fields> {
  const offerings = new Map<string, Fields>();
  for (const provider of registry.providers) {
    for (const { model, pricing, promptCache } of provider.offerings) {
      const fields: Fields = new Map();
      const add = (path: string, value: unknown) => {
        if (value === undefined) return;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          for (const [key, inner] of Object.entries(value)) add(`${path}.${key}`, inner);
        } else {
          fields.set(path, Array.isArray(value) ? `[${value.join(", ")}]` : String(value));
        }
      };
      add("model", { ...model, id: undefined });
      add("price", { ...pricing, source: undefined });
      add("cache", promptCache);
      offerings.set(`${provider.id}/${model.id}`, fields);
    }
  }
  return offerings;
}

function changeLines(before: Fields, after: Fields, test: (path: string) => boolean): string[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(test).sort();
  return paths.flatMap((path) => {
    const [was, now] = [before.get(path), after.get(path)];
    return was === now ? [] : [`${path}: ${was ?? "none"} → ${now ?? "none"}`];
  });
}

function describeOffering(fields: Fields): string {
  const price = (key: string) => fields.get(`price.${key}`) ?? "-";
  return `$${price("inputUsdPerMillionTokens")} in / $${price("outputUsdPerMillionTokens")} out per 1M tokens, context ${fields.get("model.contextWindow")}`;
}

function section(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : [`## ${title}`, "", ...lines, ""];
}

function notFromModelsDev(today: string): string[] {
  return PROVIDER_ROWS.flatMap((row) => {
    const entries = [
      {
        what: `cache lifetimes (${JSON.stringify(row.promptCache.descriptor)})`,
        ...row.promptCache,
      },
      ...(row.longCacheWrite
        ? [
            {
              what: `long-TTL cache write ${row.longCacheWrite.multiplier}x input`,
              ...row.longCacheWrite,
            },
          ]
        : []),
      ...(row.rateMultiplier
        ? [{ what: `rates ${row.rateMultiplier.multiplier}x models.dev's`, ...row.rateMultiplier }]
        : []),
    ];
    return entries.map(({ what, source, checked }) => {
      const age = Math.floor((Date.parse(today) - Date.parse(checked)) / 86_400_000);
      const flag = age > RECHECK_AFTER_DAYS ? " **re-check**: open the source before merging" : "";
      return `- \`${row.id}\` ${what}: ${source}, checked ${checked} (${age} days ago)${flag}`;
    });
  });
}

function buildReport(
  before: ModelsSnapshot,
  oldRegistry: ModelRegistry,
  newRegistry: ModelRegistry,
  today: string,
  changed: boolean,
): string {
  const [was, now] = [offeringFields(oldRegistry), offeringFields(newRegistry)];
  const isPrice = (path: string) => path.startsWith("price.");
  const added: string[] = [];
  const prices: string[] = [];
  const facts: string[] = [];
  for (const [key, fields] of now) {
    const old = was.get(key);
    if (!old) {
      const [providerId, modelId] = key.split("/");
      added.push(
        `- \`${key}\` (family \`${findFamily(providerId, modelId)?.id}\`): ${describeOffering(fields)}`,
      );
      continue;
    }
    prices.push(...changeLines(old, fields, isPrice).map((line) => `- \`${key}\` ${line}`));
    facts.push(
      ...changeLines(old, fields, (path) => !isPrice(path)).map((line) => `- \`${key}\` ${line}`),
    );
  }
  const removed = [...was.keys()].filter((key) => !now.has(key)).map((key) => `- \`${key}\``);

  const derived = newRegistry.providers.flatMap((provider) => {
    const multiplier = PROVIDER_ROWS.find((row) => row.id === provider.id)?.longCacheWrite
      ?.multiplier;
    return provider.offerings.flatMap(({ model, pricing }) =>
      multiplier === undefined
        ? []
        : [
            `- \`${provider.id}/${model.id}\`: $${pricing.inputUsdPerMillionTokens} input × ${multiplier} = $${pricing.cacheWriteLongUsdPerMillionTokens} per 1M long-TTL cache-write tokens`,
          ],
    );
  });

  const header = changed
    ? [
        `models.dev changed since the snapshot of ${before.takenAt}.`,
        "",
        "Flow charges the committed snapshot, so nothing here is billed yet. To apply it, run",
        "`pnpm models:refresh` on a branch, review the diff to `apps/server/server/lib/gateway/models-snapshot.json`,",
        "and open a PR. This issue closes itself once the snapshot matches models.dev.",
        "",
      ]
    : [`No changes since the snapshot of ${before.takenAt}.`, ""];
  return [
    ...header,
    ...section("New models", added),
    ...section("Removed models", removed),
    ...section("Price changes", prices),
    ...section("Limit, modality, reasoning and cache changes", facts),
    ...section("Derived long-TTL cache-write prices", derived),
    ...section("Not from models.dev", [
      `Held in \`provider-rows.ts\`. A date older than ${RECHECK_AFTER_DAYS} days means someone should open the source and confirm it still holds.`,
      "",
      ...notFromModelsDev(today),
    ]),
  ].join("\n");
}

const before = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ModelsSnapshot;
const today = new Date().toISOString().slice(0, 10);
const providers = offeredModels(await loadCatalog(args.api as string));
const changed = JSON.stringify(providers) !== JSON.stringify(before.providers);
const after: ModelsSnapshot = { takenAt: changed ? today : before.takenAt, providers };

// Building the registry checks the new rows (default model present, tiers that fit) before anything is written.
const report = buildReport(
  before,
  buildModelRegistry(before),
  buildModelRegistry(after),
  today,
  changed,
);

if (changed && !args["dry-run"]) {
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(after, null, 2)}\n`);
}
if (changed && args["report-file"]) {
  const body =
    report.length > MAX_REPORT_CHARS
      ? `${report.slice(0, MAX_REPORT_CHARS)}\n\n…truncated; run \`pnpm models:refresh\` for the full report.`
      : report;
  writeFileSync(args["report-file"], body);
}
console.log(report);
