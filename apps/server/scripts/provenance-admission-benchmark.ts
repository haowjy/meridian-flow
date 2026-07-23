/** Paired I1/current writer-admission latency and zero-write instrumentation gate. */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { UpdateJournal } from "@meridian/agent-edit";
import { createDb } from "@meridian/database";
import {
  buildDocumentSchema,
  createCollabYDoc,
  isReservedClientId,
} from "@meridian/prosemirror-schema";
import { sql } from "drizzle-orm";
import { updateYFragment } from "y-prosemirror";
import * as Y from "yjs";
import { createDrizzleJournal } from "../server/domains/collab/adapters/drizzle-journal.js";
import {
  primeReservedNamespaceIndex,
  provenanceInstrumentation,
  resetProvenanceInstrumentation,
} from "../server/domains/collab/domain/provenance.js";
import { createHocuspocusPersistenceService } from "../server/domains/collab/hocuspocus-persistence.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000901" as never;
const SAMPLE_COUNT = 40;
const ADMISSIONS_PER_DAY = 100;
const WORDS_PER_ADMISSION = 100;
const traceWarnings: string[] = [];
const trace = captureYjsWarnings(() => productionWriterTrace(), traceWarnings);
const postgresBaseline = JSON.parse(
  readFileSync(new URL("./provenance-admission-postgres-baseline.json", import.meta.url), "utf8"),
) as PostgresBaseline;

type Counters = {
  transactions: number;
  journalBytes: number;
  provenanceRows: number;
  provenanceBytes: number;
};

type DayResult = { elapsedMs: number; latenciesMs: number[]; counters: Counters };
type PostgresBaseline = {
  fixture: { admissions: number; words: number; transactions: number; journalBytes: number };
  environment: { cpu: string; os: string };
  observedMs: { mean: number; p50: number; p95: number; p99: number };
};

const baselineDays: DayResult[] = [];
const currentDays: DayResult[] = [];
for (let warmup = 0; warmup < 3; warmup += 1) {
  await runBaselineDay();
  await runCurrentDay();
}
for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
  if (sample % 2 === 0) {
    baselineDays.push(await runBaselineDay());
    currentDays.push(await runCurrentDay());
  } else {
    currentDays.push(await runCurrentDay());
    baselineDays.push(await runBaselineDay());
  }
}

const baselineLatencies = baselineDays.flatMap((sample) => sample.latenciesMs);
const currentLatencies = currentDays.flatMap((sample) => sample.latenciesMs);
const pairedPerAdmissionDeltas = baselineDays.map(
  (baseline, index) =>
    ((currentDays[index]?.elapsedMs ?? Number.NaN) - baseline.elapsedMs) / ADMISSIONS_PER_DAY,
);
const ci = meanConfidenceInterval(pairedPerAdmissionDeltas);
const percentiles = [50, 95, 99].map((percentile) => ({
  percentile,
  baselineMs: quantile(baselineLatencies, percentile / 100),
  currentMs: quantile(currentLatencies, percentile / 100),
  deltaMs:
    quantile(currentLatencies, percentile / 100) - quantile(baselineLatencies, percentile / 100),
}));
const baselineCounters = sumCounters(baselineDays);
const currentCounters = sumCounters(currentDays);
const p99Delta = percentiles.find(({ percentile }) => percentile === 99)?.deltaMs ?? Number.NaN;
const postgresAdmission = process.argv.includes("--postgres")
  ? await measurePostgresAdmission()
  : null;
const postgresFixtureMatchesBaseline =
  postgresAdmission === null ||
  (trace.length === postgresBaseline.fixture.admissions &&
    ADMISSIONS_PER_DAY * WORDS_PER_ADMISSION === postgresBaseline.fixture.words &&
    postgresAdmission.transactions === postgresBaseline.fixture.transactions &&
    postgresAdmission.bytes === postgresBaseline.fixture.journalBytes);
const passed =
  ci.high <= 0.05 &&
  Math.abs(p99Delta) <= 0.5 &&
  baselineCounters.transactions === currentCounters.transactions &&
  baselineCounters.journalBytes === currentCounters.journalBytes &&
  currentCounters.provenanceRows === 0 &&
  currentCounters.provenanceBytes === 0 &&
  provenanceInstrumentation().enumerations === 0 &&
  traceWarnings.length === 0 &&
  postgresFixtureMatchesBaseline;

console.log(
  JSON.stringify(
    {
      passed,
      sampleCount: SAMPLE_COUNT,
      admissionsPerDay: ADMISSIONS_PER_DAY,
      wordsPerDay: ADMISSIONS_PER_DAY * WORDS_PER_ADMISSION,
      percentiles,
      pairedMeanDeltaMs: ci.mean,
      pairedMeanDelta95CiMs: [ci.low, ci.high],
      baselineCounters,
      currentCounters,
      provenanceEnumerationsDuringAdmission: provenanceInstrumentation().enumerations,
      harnessWarnings: traceWarnings,
      postgresAdmission,
      postgresBaseline,
      postgresFixtureMatchesBaseline,
    },
    null,
    2,
  ),
);
if (!passed) process.exitCode = 1;

async function runCurrentDay(): Promise<DayResult> {
  const liveDocument = new Y.Doc({ gc: false });
  primeReservedNamespaceIndex(liveDocument);
  resetProvenanceInstrumentation();
  const counters = emptyCounters();
  const journal = countingJournal(counters);
  const port = createHocuspocusPersistenceService({
    journal,
    hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
    metaForOrigin: () => ({ origin: "human:benchmark-user", seq: 0 }),
    latestUpdateSeq: async () => 0,
    emitAgentEditInvariantViolation: () => undefined,
  });
  return runDay(async (update) => {
    await port.admitLiveWriterUpdate({
      documentId: DOCUMENT_ID,
      document: liveDocument,
      update,
      origin: { type: "user", userId: "benchmark-user" },
      expectedGeneration: 1n,
    });
    Y.applyUpdate(liveDocument, update);
  }, counters);
}

async function measurePostgresAdmission(): Promise<{
  transactions: number;
  bytes: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  const userId = process.env.PROVENANCE_BENCHMARK_USER_ID;
  if (!databaseUrl || !userId) {
    throw new Error("--postgres requires DATABASE_URL and PROVENANCE_BENCHMARK_USER_ID");
  }
  const db = createDb(databaseUrl, { max: 1 });
  const journal = createDrizzleJournal(db);
  const latencies: number[] = [];
  try {
    await db.execute(sql`select 1`);
    for (const update of trace) {
      const before = performance.now();
      await journal.appendWriterUpdate?.(DOCUMENT_ID, update, {
        origin: `human:${userId}`,
        seq: 0,
      });
      latencies.push(performance.now() - before);
    }
  } finally {
    await db.close();
  }
  return {
    transactions: latencies.length,
    bytes: trace.reduce((sum, update) => sum + update.byteLength, 0),
    meanMs: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    p50Ms: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
    p99Ms: quantile(latencies, 0.99),
  };
}

async function runBaselineDay(): Promise<DayResult> {
  const counters = emptyCounters();
  const journal = countingJournal(counters);
  return runDay(async (update) => {
    const reserved = Y.decodeUpdate(update).structs.some((struct) =>
      isReservedClientId(struct.id.client),
    );
    if (reserved) throw new Error("reserved-writer-client-id");
    await journal.appendWriterUpdate?.(DOCUMENT_ID, update, {
      origin: "human:benchmark-user",
      seq: 0,
    });
  }, counters);
}

async function runDay(
  admit: (update: Uint8Array) => Promise<void>,
  counters: Counters,
): Promise<DayResult> {
  const latenciesMs: number[] = [];
  const started = performance.now();
  for (const update of trace) {
    const before = performance.now();
    await admit(update);
    latenciesMs.push(performance.now() - before);
  }
  return { elapsedMs: performance.now() - started, latenciesMs, counters };
}

function productionWriterTrace(): Uint8Array[] {
  const schema = buildDocumentSchema();
  const client = createCollabYDoc({ gc: false });
  const fragment = client.getXmlFragment("prosemirror");
  const binding = { mapping: new Map(), isOMark: new Map() };
  let vector = Y.encodeStateVector(client);
  let text = "";
  const updates: Uint8Array[] = [];
  for (let admission = 0; admission < ADMISSIONS_PER_DAY; admission += 1) {
    text += "word ".repeat(WORDS_PER_ADMISSION);
    const paragraph = schema.nodes.paragraph?.create(null, schema.text(text));
    if (!paragraph) throw new Error("Benchmark schema has no paragraph node");
    updateYFragment(client, fragment, schema.topNodeType.create(null, [paragraph]), binding);
    updates.push(Y.encodeStateAsUpdate(client, vector));
    vector = Y.encodeStateVector(client);
  }
  return updates;
}

function captureYjsWarnings<T>(run: () => T, warnings: string[]): T {
  const originalWarn = console.warn;
  const originalError = console.error;
  const capture = (...values: unknown[]) => warnings.push(values.map(String).join(" "));
  console.warn = capture;
  console.error = capture;
  try {
    return run();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function countingJournal(counters: Counters): UpdateJournal {
  return {
    append: async () => 0,
    appendWriterUpdate: async (_documentId, update) => {
      counters.transactions += 1;
      counters.journalBytes += update.byteLength;
      return { seq: counters.transactions, joinedSettlement: false };
    },
    appendBatch: async () => [],
    read: async () => ({ checkpoint: null, updates: [] }),
    checkpoint: async () => undefined,
    compact: async () => ({ updatesFolded: 0, reversalsExpired: 0 }),
  };
}

function emptyCounters(): Counters {
  return { transactions: 0, journalBytes: 0, provenanceRows: 0, provenanceBytes: 0 };
}

function sumCounters(days: readonly DayResult[]): Counters {
  return days.reduce(
    (sum, day) => ({
      transactions: sum.transactions + day.counters.transactions,
      journalBytes: sum.journalBytes + day.counters.journalBytes,
      provenanceRows: sum.provenanceRows + day.counters.provenanceRows,
      provenanceBytes: sum.provenanceBytes + day.counters.provenanceBytes,
    }),
    emptyCounters(),
  );
}

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;
}

function meanConfidenceInterval(values: readonly number[]): {
  mean: number;
  low: number;
  high: number;
} {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { mean, low: mean - margin, high: mean + margin };
}
