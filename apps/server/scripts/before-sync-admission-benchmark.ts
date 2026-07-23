/** Before/after latency gate for the history-heavy writer admission path. */

import { performance } from "node:perf_hooks";
import type { UpdateJournal } from "@meridian/agent-edit";
import * as Y from "yjs";
import { createDocumentAuthority } from "../server/domains/collab/domain/document-authority.js";
import { createDocumentContainment } from "../server/domains/collab/domain/document-containment.js";
import { validateClientUpdateAdmission } from "../server/domains/collab/domain/provenance.js";
import { createHocuspocusPersistenceService } from "../server/domains/collab/hocuspocus-persistence.js";

const DOCUMENT_ID = "00000000-0000-4000-8000-000000000281" as never;
const HISTORY_CLIENTS = 5_000;
const SAMPLES = 500;
const document = new Y.Doc({ gc: false });
let containedUpdate = new Uint8Array();

for (let index = 0; index < HISTORY_CLIENTS; index += 1) {
  const client = new Y.Doc({ gc: false });
  client.clientID = 10_000 + index;
  client.getText("history").insert(0, "x");
  const update = Y.encodeStateAsUpdate(client);
  if (index === 0) containedUpdate = update;
  Y.applyUpdate(document, update);
  client.destroy();
}

const novelClient = new Y.Doc({ gc: false });
novelClient.clientID = 1_000_000;
novelClient.getText("content").insert(0, "writer");
const novelUpdate = Y.encodeStateAsUpdate(novelClient);
novelClient.destroy();

let sequence = 0;
const journal = {
  async append() {
    sequence += 1;
    return sequence;
  },
  async appendWriterUpdate() {
    sequence += 1;
    return { seq: sequence, joinedSettlement: false };
  },
} as unknown as UpdateJournal;
const currentAdmission = createHocuspocusPersistenceService({
  journal,
  hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, document]]) }) as never,
  metaForOrigin: () => ({ origin: "human:benchmark", seq: 0 }),
  latestUpdateSeq: async () => 0,
  emitAgentEditInvariantViolation: () => undefined,
});
const containment = createDocumentContainment();

await warm(async () => oldAdmission(novelUpdate));
await warm(async () =>
  currentAdmission.admitLiveWriterUpdate({
    documentId: DOCUMENT_ID,
    document,
    update: novelUpdate,
    origin: { type: "user", userId: "benchmark" },
    expectedGeneration: 1n,
  }),
);
warmSync(() => Y.snapshot(document));
warmSync(() => Y.snapshotContainsUpdate(Y.snapshot(document), containedUpdate));
warmSync(() => containment.contains(document, containedUpdate));

const result = {
  fixture: { retainedStructs: HISTORY_CLIENTS, samples: SAMPLES },
  admissionMs: {
    before: await measureAsync(() => oldAdmission(novelUpdate)),
    after: await measureAsync(() =>
      currentAdmission.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document,
        update: novelUpdate,
        origin: { type: "user", userId: "benchmark" },
        expectedGeneration: 1n,
      }),
    ),
  },
  snapshotConstructionMs: measureSync(() => Y.snapshot(document)),
  containedUpdateMs: {
    before: measureSync(() => Y.snapshotContainsUpdate(Y.snapshot(document), containedUpdate)),
    after: measureSync(() => containment.contains(document, containedUpdate)),
  },
};

console.log(JSON.stringify(result, null, 2));
const containmentSpeedup = result.containedUpdateMs.before.p50 / result.containedUpdateMs.after.p50;
if (containmentSpeedup < 10) {
  console.error(
    `Writer admission performance regression: cached containment was only ${containmentSpeedup.toFixed(1)}x faster than snapshot reconstruction (minimum 10x)`,
  );
  process.exitCode = 1;
}
document.destroy();

async function oldAdmission(update: Uint8Array): Promise<void> {
  const admission = validateClientUpdateAdmission(document, update);
  if (admission.reservedClientId !== null) throw new Error("reserved-writer-client-id");
  if (Y.snapshotContainsUpdate(Y.snapshot(document), update)) return;

  const unsupported = async (): Promise<never> => {
    throw new Error("unsupported");
  };
  const authority = createDocumentAuthority({
    readMutableAuthority: () => ({ documentId: DOCUMENT_ID, generation: 0n, doc: document }),
    admitImmediate: async () => ({ sequence: BigInt(++sequence), joined: 0 }),
    readFrozenCut: unsupported,
    readCurrentRevision: unsupported,
    lowerCertifiedMutation: unsupported,
    loadCheckpoint: unsupported,
    unresolvedSettlements: unsupported,
    replaceGeneration: unsupported,
    disconnectGeneration: unsupported,
    stagePush: unsupported,
    completePush: unsupported,
  });
  await authority.mutate({
    kind: "attributedFreshAuthorship",
    source: { kind: "writer" },
    update,
  });
}

async function measureAsync(operation: () => Promise<unknown>) {
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await operation();
    values.push(performance.now() - started);
  }
  return percentiles(values);
}

function measureSync(operation: () => unknown) {
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    operation();
    values.push(performance.now() - started);
  }
  return percentiles(values);
}

async function warm(operation: () => Promise<unknown>): Promise<void> {
  for (let index = 0; index < 25; index += 1) await operation();
}

function warmSync(operation: () => unknown): void {
  for (let index = 0; index < 25; index += 1) operation();
}

function percentiles(values: number[]) {
  values.sort((left, right) => left - right);
  return { p50: quantile(values, 0.5), p99: quantile(values, 0.99) };
}

function quantile(sorted: readonly number[], percentile: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  return sorted[index] ?? Number.NaN;
}
