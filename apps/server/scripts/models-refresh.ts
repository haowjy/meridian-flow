/**
 * `pnpm models:refresh`: rewrites `models-snapshot.json` from https://models.dev/api.json and
 * prints what changed. Billing charges the committed snapshot, never live data, so a person
 * reviews this report and commits the snapshot in a PR. Needs the network, so it is outside
 * `pnpm check`; the daily `models-refresh` workflow runs it and files the report as an issue.
 *
 *   --api <url|path>      read the catalog from here instead of models.dev
 *   --dry-run             report mode: print the report and leave the snapshot as it is. A row
 *                         Flow cannot serve becomes a report section; without this flag it is
 *                         an error and nothing is written.
 *   --report-file <path>  also write the report there, only when something changed
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findFamily } from "../server/lib/gateway/families.js";
import { factsOf, PROVIDERS, type ProviderData } from "../server/lib/gateway/model-data.js";
import {
  buildModelRegistry,
  type ModelRegistry,
  type ModelsSnapshot,
  modelDataGaps,
  type SnapshotModel,
  unservableReason,
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
    release_date: model.release_date,
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

/** The rows each family admits, and the family-matched rows Flow cannot serve (as report lines). */
function offeredModels(catalog: Catalog): {
  providers: ModelsSnapshot["providers"];
  unservable: string[];
} {
  const unservable: string[] = [];
  const providers = Object.fromEntries(
    PROVIDERS.map((row) => {
      const models = catalog[row.modelsDev ?? row.id]?.models ?? {};
      const offered = Object.keys(models)
        .sort()
        .filter((id) => models[id].status !== "deprecated")
        .flatMap((id) => {
          const family = findFamily(row.id, id);
          if (!family) return [];
          const problem = unservableReason(models[id]);
          if (problem) {
            unservable.push(
              `- \`${row.id}/${id}\` matched family \`${family.id}\`, but Flow can't serve it: ${problem}. Add an exclude to \`families.ts\`.`,
            );
            return [];
          }
          return [[id, pick(models[id])]];
        });
      return [row.id, Object.fromEntries(offered)];
    }),
  );
  return { providers, unservable };
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
  return PROVIDERS.flatMap((row) =>
    Object.entries(row.models).flatMap(([model, facts]) =>
      Object.entries(facts).map(([name, { value, source, checked, note }]) => {
        const age = Math.floor((Date.parse(today) - Date.parse(checked)) / 86_400_000);
        const flag =
          age > RECHECK_AFTER_DAYS ? " **re-check**: open the source before merging" : "";
        return `- \`${row.id}/${model}\` ${name} ${JSON.stringify(value)}: ${source}, checked ${checked} (${age} days ago)${flag}${note ? `. ${note}` : ""}`;
      }),
    ),
  );
}

type CostField = "input" | "output" | "cache_read" | "cache_write";
const COST_FIELDS: readonly CostField[] = ["input", "output", "cache_read", "cache_write"];

/** Overridden prices with models.dev's number beside the billed one, and when an override can go. */
function overrideLines(before: ModelsSnapshot, after: ModelsSnapshot): string[] {
  return PROVIDERS.flatMap((row) =>
    Object.keys(after.providers[row.id] ?? {}).flatMap((id) => {
      const override = factsOf(row, id).price;
      const [was, now] = [before.providers[row.id]?.[id], after.providers[row.id]?.[id]];
      if (!override || !now) return [];
      const fields = COST_FIELDS.filter((field) => override.value[field] !== undefined);
      const parts = fields.map((field) => {
        const moved = was && was.cost[field] !== now.cost[field] ? ` (was ${was.cost[field]})` : "";
        return `${field}: models.dev $${now.cost[field]}${moved}, billed $${override.value[field]}`;
      });
      const agrees = fields.every((field) => now.cost[field] === override.value[field]);
      return [
        `- \`${row.id}/${id}\` ${parts.join("; ")}. Override per ${override.source}, checked ${override.checked}.${agrees ? " **models.dev now agrees: delete the override.**" : ""}`,
      ];
    }),
  );
}

/** Cache rates models.dev dropped: billing then charges those tokens at the input rate. */
function droppedCacheRates(before: ModelsSnapshot, after: ModelsSnapshot): string[] {
  return Object.entries(after.providers).flatMap(([providerId, models]) =>
    Object.entries(models).flatMap(([id, model]) => {
      const old = before.providers[providerId]?.[id];
      return (["cache_read", "cache_write"] as const)
        .filter((field) => old?.cost[field] !== undefined && model.cost[field] === undefined)
        .map(
          (field) =>
            `- \`${providerId}/${id}\`: models.dev dropped \`${field}\` (was $${old?.cost[field]}). Billing would charge those tokens at the input rate.`,
        );
    }),
  );
}

function buildReport(input: {
  before: ModelsSnapshot;
  after: ModelsSnapshot;
  oldRegistry: ModelRegistry;
  newRegistry: ModelRegistry;
  today: string;
  unservable: readonly string[];
  buildError: string | undefined;
  /** Where price overrides leave a model or a rate at models.dev's price. */
  dataGaps: readonly string[];
  /** The snapshot differs from models.dev, or something can't be served. */
  changed: boolean;
}): string {
  const {
    before,
    after,
    oldRegistry,
    newRegistry,
    today,
    unservable,
    buildError,
    dataGaps,
    changed,
  } = input;
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
    const row = PROVIDERS.find((candidate) => candidate.id === provider.id) as ProviderData;
    return provider.offerings.flatMap(({ model, pricing }) => {
      const multiplier = factsOf(row, model.id).longCacheWrite?.value.multiplier;
      return multiplier === undefined
        ? []
        : [
            `- \`${provider.id}/${model.id}\`: $${pricing.inputUsdPerMillionTokens} input × ${multiplier} = $${pricing.cacheWriteLongUsdPerMillionTokens} per 1M long-TTL cache-write tokens`,
          ];
    });
  });

  const header = changed
    ? [
        `models.dev changed since the snapshot of ${before.takenAt}.`,
        "",
        "Flow charges the committed snapshot, so nothing here is billed yet. To apply it, run",
        "`pnpm models:refresh` on a branch, review the diff to `apps/server/server/lib/gateway/models-snapshot.json`,",
        "and open a PR. This issue closes itself once the snapshot matches models.dev.",
        ...(unservable.length > 0 || buildError || dataGaps.length > 0
          ? ["", "`pnpm models:refresh` refuses to write until the problems below are fixed."]
          : []),
        "",
      ]
    : [`No changes since the snapshot of ${before.takenAt}.`, ""];
  return [
    ...header,
    ...section("Matched a family but can't be served", unservable),
    ...section("model-data.json that does not fit the snapshot", dataGaps),
    ...section("The new snapshot would not build", buildError ? [buildError] : []),
    ...section("New models", added),
    ...section("Removed models", removed),
    ...section("Price changes", prices),
    ...section("Dropped cache rates", droppedCacheRates(before, after)),
    ...section("Limit, modality, reasoning and cache changes", facts),
    ...section("Prices Flow charges that differ from models.dev's", overrideLines(before, after)),
    ...section("Derived long-TTL cache-write prices", derived),
    ...section("Not from models.dev", [
      `Held in \`model-data.json\`. A date older than ${RECHECK_AFTER_DAYS} days means someone should open the source and confirm it still holds.`,
      "",
      ...notFromModelsDev(today),
    ]),
  ].join("\n");
}

const dryRun = args["dry-run"];
const before = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as ModelsSnapshot;
const today = new Date().toISOString().slice(0, 10);
const { providers, unservable } = offeredModels(await loadCatalog(args.api as string));
if (unservable.length > 0 && !dryRun) {
  throw new Error(`Nothing written.\n${unservable.join("\n")}`);
}
const snapshotChanged = JSON.stringify(providers) !== JSON.stringify(before.providers);
const after: ModelsSnapshot = { takenAt: snapshotChanged ? today : before.takenAt, providers };

// Building the registry checks the new rows (default model present, tiers that fit) before anything is written.
// Report mode lists the price-override gaps and builds the registry anyway, so every other change still shows.
const oldRegistry = buildModelRegistry(before);
let newRegistry = oldRegistry;
let buildError: string | undefined;
const dataGaps = modelDataGaps(after);
if (!dryRun && dataGaps.length > 0) throw new Error(`Nothing written.\n${dataGaps.join("\n")}`);
try {
  newRegistry = buildModelRegistry(after);
} catch (error) {
  if (!dryRun) throw error;
  buildError = (error as Error).message;
}
const changed =
  snapshotChanged || unservable.length > 0 || buildError !== undefined || dataGaps.length > 0;
const report = buildReport({
  before,
  after,
  oldRegistry,
  newRegistry,
  today,
  unservable,
  buildError,
  dataGaps,
  changed,
});

if (snapshotChanged && !dryRun) {
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
