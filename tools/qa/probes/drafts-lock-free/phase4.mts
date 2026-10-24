/**
 * What the phase 4 probes share (design `phase4-crdt-appends.md`, §9): readers of the journal,
 * receipts and effect columns, a process with the projection job wired as composition wires
 * it, and the pauses that order two writers by a hook or a held call rather than by a sleep.
 */

import { WS_CLOSE } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import {
  createDraftProjection,
  type DraftProjectionDiagnostics,
} from "../../../../apps/server/server/domains/collab/domain/draft-projection.ts";
import { createDraftPullService } from "../../../../apps/server/server/domains/collab/domain/draft-pulls.ts";
import {
  type DraftStore,
  materializeDraftRead,
} from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import type { WriterFrameDiagnostics } from "../../../../apps/server/server/domains/collab/domain/draft-writer-frames.ts";
import { runOutsideWrite } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import {
  setTestHook,
  type TestHookPoint,
} from "../../../../apps/server/server/shared/test-hooks.ts";
import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
} from "../../../../packages/agent-edit/src/diff/index.ts";
import { gate, type Harness, settled, Y } from "./harness.mts";

/** The resync close: not a refusal, never counted by the client (design §2.7, D30). */
export const PREFIX_MISSING_CLOSE = WS_CLOSE.DRAFT_PREFIX_MISSING;

export type EffectWrite = Awaited<ReturnType<DraftStore["writeEffect"]>>;

const noop = () => {};

/** A coordinator over `store` with the required `onAppendCommitted` (§3.1). */
export function phase4Coordinator(
  harness: Harness,
  input: {
    store?: DraftStore;
    onAppendCommitted?: (draftId: string) => void;
    onDraftUpdate?: (input: { draftId: string; update: Uint8Array }) => void;
    diagnostics?: Partial<WriterFrameDiagnostics>;
  } = {},
) {
  return createDraftCoordinator({
    store: input.store ?? harness.store,
    attemptScope: harness.attemptScope,
    onAppendCommitted: input.onAppendCommitted ?? noop,
    ...(input.onDraftUpdate ? { onDraftUpdate: input.onDraftUpdate } : {}),
    diagnostics: {
      compactionFailed: noop,
      roomReconciled: noop,
      appendPrefixMissing: noop,
      ...input.diagnostics,
    },
  });
}

/** A writer frame's outcome as the probes name them (§8.2's `AppendRowsOutcome`, at the frame). */
export type FrameOutcome =
  | "appended"
  | "contained"
  | "prefixMissing"
  | { refused: string; message: string };

export async function frameOutcome(promise: Promise<{ admitted: boolean }>): Promise<FrameOutcome> {
  const result = await settled(promise);
  if (result.ok) return result.value.admitted ? "appended" : "contained";
  if (result.name === "DraftPrefixMissingError") return "prefixMissing";
  return { refused: result.name, message: result.message };
}

/** The draft's journal rows of every generation, in id order. */
export async function journalRows(harness: Harness, draftId: string) {
  const rows = await harness.raw<
    { id: string; source: string; update_data: Uint8Array; update_meta: unknown }[]
  >`select id, source, update_data, update_meta from draft_write_journal
    where draft_id = ${draftId} order by id`;
  return rows.map((row) => ({
    id: Number(row.id),
    source: row.source,
    update: new Uint8Array(row.update_data),
    meta: (row.update_meta ?? {}) as { restorationAliases?: unknown[] } & Record<string, unknown>,
  }));
}

type Range = { client: number; clock: number; len: number };

/** Every receipt on the draft's rows: one entry per `document_edits` row, parts in order. */
export async function receipts(harness: Harness, draftId: string) {
  const rows = await harness.raw<
    {
      edit_id: string;
      ordinal: number;
      row_id: string | null;
      effect: { inserted: Range[]; deleted: Range[] };
      frontier: Record<string, number>;
    }[]
  >`select p.edit_id, p.ordinal, p.origin->>'rowId' as row_id, p.effect, p.frontier
    from document_edit_parts p
    join draft_write_journal j on j.id = (p.origin->>'rowId')::bigint
    where p.origin->>'kind' = 'pending' and j.draft_id = ${draftId}
    order by p.edit_id, p.ordinal`;
  const edits = new Map<
    string,
    { rowId: number; effect: Range[][]; frontier: Record<string, number> }[]
  >();
  for (const row of rows) {
    const parts = edits.get(row.edit_id) ?? [];
    parts.push({
      rowId: Number(row.row_id),
      effect: [row.effect.inserted, row.effect.deleted],
      frontier: row.frontier,
    });
    edits.set(row.edit_id, parts);
  }
  return [...edits.values()].map((parts) =>
    parts.map(({ rowId, effect: [inserted, deleted], frontier }) => ({
      rowId,
      inserted: inserted ?? [],
      deleted: deleted ?? [],
      frontier,
    })),
  );
}

/** The draft row's sequence and projection columns; `watermark` is null before 0064. */
export async function draftRow(harness: Harness, draftId: string) {
  const [row] = await harness.raw<Record<string, unknown>[]>`
    select * from document_drafts where id = ${draftId}`;
  if (!row) throw new Error(`Draft ${draftId} is missing`);
  return {
    revision: Number(row.revision),
    checkpointSeq: Number(row.checkpoint_seq),
    hasEffect: Boolean(row.has_effect),
    watermark: row.has_effect_revision === undefined ? null : Number(row.has_effect_revision),
    updatedAt: row.updated_at as Date,
  };
}

/** The structs an update carries, as `client:clock+len`. */
export function structsOf(update: Uint8Array): string[] {
  return Y.decodeUpdate(update).structs.map(
    (struct) => `${struct.id.client}:${struct.id.clock}+${struct.length}`,
  );
}

/**
 * A paused point: the first caller to reach it (for which `when` holds, if given) waits for
 * `release`; every other caller passes.
 */
export function pauseAt(point: TestHookPoint, when: () => boolean = () => true) {
  const entered = gate();
  const release = gate();
  let held = false;
  const remove = setTestHook(point, async () => {
    if (held || !when()) return;
    held = true;
    entered.open();
    await release.wait;
  });
  return {
    entered: entered.wait,
    release() {
      release.open();
    },
    remove() {
      release.open();
      remove();
    },
  };
}

/**
 * `store` whose first `appendRows` holds after the frame judged its bytes off the lock and
 * before it takes the draft row: "A read at r; B commits; A appends".
 */
export function pausedAppend(store: DraftStore) {
  const entered = gate();
  const release = gate();
  let held = false;
  const paused: DraftStore = {
    ...store,
    async appendRows(input) {
      if (!held) {
        held = true;
        entered.open();
        await release.wait;
      }
      return store.appendRows(input);
    },
  };
  return { paused, entered: entered.wait, release: release.open };
}

/** p50, p95 and max of `samples`, rounded to a millisecond. */
export function percentiles(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  return { p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1) ?? 0), n: sorted.length };
}

/** The first paragraph's text node, for a probe that deletes from it. */
export function firstText(doc: Y.Doc): Y.XmlText {
  const paragraph = doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  return paragraph.get(0) as Y.XmlText;
}

/** A tab on `source`'s state with its own client id. */
export function tabOn(source: Y.Doc, clientID: number): Y.Doc {
  const tab = new Y.Doc({ gc: false });
  tab.clientID = clientID;
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(source));
  return tab;
}

/** The update one change on `doc` produces. */
export function captureUpdate(doc: Y.Doc, change: () => void): Uint8Array {
  let captured: Uint8Array | undefined;
  const listen = (update: Uint8Array) => {
    captured = captured ? Y.mergeUpdates([captured, update]) : update;
  };
  doc.on("update", listen);
  try {
    change();
  } finally {
    doc.off("update", listen);
  }
  if (!captured) throw new Error("The change produced no update");
  return captured;
}

/** A fresh Work, its branch and one document over `text`, with the document's draft ensured in that branch. */
export async function seedDraft(harness: Harness, label: string, text = "Base") {
  const work = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, text);
  const documentDraft = await harness.store.ensureDocumentDraft({
    documentId,
    branchId: work.branchId,
    liveDoc: live,
    liveRoom: null,
  });
  return { ...work, documentId, live, draftId: documentDraft.draftId };
}

/** Persist live's delta, then run the production committed-live content rebase. */
export async function rebaseLive(
  harness: Harness,
  coordinator: ReturnType<typeof createDraftCoordinator>,
  documentId: DocumentId,
  live: Y.Doc,
): Promise<void> {
  const committed = await harness.liveDoc(documentId);
  try {
    const update = Y.encodeStateAsUpdate(live, Y.encodeStateVector(committed));
    await harness.persistence.journal.append(documentId, update, { origin: "system", seq: 0 });
  } finally {
    committed.destroy();
  }
  const pulls = createDraftPullService({
    outsideTransaction: (operation) => operation(),
    drafts: harness.store,
    liveJournal: harness.persistence.journal,
    draftCoordinator: coordinator,
  });
  try {
    await pulls.flushLivePull(documentId);
  } finally {
    pulls.cancelScheduledPulls();
  }
}

type Frames = {
  commitWriterUpdate: ReturnType<typeof createDraftCoordinator>["commitWriterUpdate"];
};

/**
 * One tab's room in one process: frames go through `coordinator` as the gateway sends them,
 * and an admitted one is applied to the room as Hocuspocus applies it.
 */
export async function openRoom(harness: Harness, coordinator: Frames, draft: { draftId: string }) {
  const room = await durableDoc(harness, draft.draftId);
  return {
    room,
    async send(update: Uint8Array): Promise<FrameOutcome> {
      const outcome = await frameOutcome(
        coordinator.commitWriterUpdate({
          draftId: draft.draftId,
          updateData: update,
          roomDocument: room,
        }),
      );
      if (outcome === "appended" || outcome === "contained") Y.applyUpdate(room, update, "client");
      return outcome;
    },
  };
}

/**
 * Runs every arm, printing each one's result, and fails once at the end naming the arms that
 * failed: one run tells lane 1 every arm's observed outcome, not only the first failure's.
 */
export async function runArms(arms: Record<string, () => Promise<void>>): Promise<void> {
  const failed: string[] = [];
  for (const [name, arm] of Object.entries(arms)) {
    try {
      await arm();
      console.log(`  arm ${name}: PASS`);
    } catch (cause) {
      failed.push(name);
      const message =
        cause instanceof Error
          ? cause.message.split("\n").slice(0, 6).join("\n    ")
          : String(cause);
      console.log(`  arm ${name}: FAIL ${message}`);
    }
  }
  if (failed.length) throw new Error(`arms failed: ${failed.join(", ")}`);
}

/** `items[index]` (negative from the end), or a failure naming what was missing. */
export function nth<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`No item ${index} among ${items.length}`);
  return item;
}

/** The draft as committed now, materialized; the caller destroys it. */
export async function durableDoc(harness: Harness, draftId: string): Promise<Y.Doc> {
  const read = await harness.store.readDraftAt(draftId);
  if (!read) throw new Error(`Draft ${draftId} is missing`);
  return materializeDraftRead(read);
}

/**
 * One server process: its coordinator over `store` (its own connections when `store` is
 * another harness's) and one room, which every delivery of this process reaches. `dirty`
 * counts the coordinator's `onAppendCommitted` marks.
 */
export async function openProcess(
  harness: Harness,
  draft: { draftId: string },
  store: DraftStore = harness.store,
) {
  const room = await durableDoc(harness, draft.draftId);
  const dirty: string[] = [];
  const coordinator = phase4Coordinator(harness, {
    store,
    onAppendCommitted: (draftId) => dirty.push(draftId),
    onDraftUpdate: ({ update }) => Y.applyUpdate(room, update, "deliver"),
  });
  await coordinator.readDraft(draft.draftId, async () => {});
  return { room, coordinator, dirty };
}

/** A tab's keystroke on `room`'s state: a fresh client appending `token`. */
export function keystroke(room: Y.Doc, token: string, clientID?: number): Uint8Array {
  const tab = new Y.Doc({ gc: false });
  if (clientID !== undefined) tab.clientID = clientID;
  try {
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    const paragraph = tab.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    const text = paragraph.get(0) as Y.XmlText;
    return captureUpdate(tab, () => text.insert(text.length, token));
  } finally {
    tab.destroy();
  }
}

/**
 * Waits until `promise` settles or a probe connection waits on a lock matching `match`,
 * whichever is first: an operation that should not block on a held row either finishes or
 * names the lock it is stuck behind.
 */
export async function settledOrWaiting<T>(
  harness: Harness,
  promise: Promise<T>,
  match: RegExp,
  timeoutMs = 5_000,
): Promise<{ settled: true; value: T } | { settled: false; waiting: string[] }> {
  const waiters = async () =>
    harness.raw<{ pid: number; query: string }[]>`
      select pid, query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
  // Connections already waiting belong to someone else: only a new waiter is `promise`'s.
  const before = new Set((await waiters()).map((row) => row.pid));
  let result: { value: T } | undefined;
  void promise.then((value) => {
    result = { value };
  });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (result) return { settled: true, value: result.value };
    const waiting = (await waiters())
      .filter((row) => !before.has(row.pid) && match.test(row.query))
      .map((row) => row.query.slice(0, 80));
    if (waiting.length) return { settled: false, waiting };
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`Neither settled nor waiting on ${match} within ${timeoutMs} ms`);
}

/**
 * Polls `observe` every 10 ms until `done(observation)` or `withinMs` passes: the latency a
 * projection takes to catch up, which no hook can order. Returns the elapsed time; past the
 * deadline it fails with the last observation.
 */
export async function within<T>(
  withinMs: number,
  observeNow: () => Promise<T>,
  done: (observation: T) => boolean,
): Promise<{ elapsedMs: number; observation: T }> {
  const started = performance.now();
  for (;;) {
    const observation = await observeNow();
    const elapsedMs = Math.round(performance.now() - started);
    if (done(observation)) return { elapsedMs, observation };
    if (elapsedMs > withinMs)
      throw new Error(`Not within ${withinMs} ms: ${JSON.stringify(observation)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The Work's badge as a Works snapshot serves it: its stored pending count and revision. */
export async function workBadge(harness: Harness, workId: string) {
  const [row] = await harness.raw<{ pending_document_count: number; entity_revision: string }[]>`
    select pending_document_count, entity_revision from works where id = ${workId}`;
  return {
    pending: Number(row?.pending_document_count),
    entityRevision: Number(row?.entity_revision),
  };
}

/**
 * A process with the projection job wired as composition wires it (§3.1, §3.2): every durable
 * append marks its draft dirty; `failed` records projection diagnostics.
 */
export async function openProjected(
  harness: Harness,
  options: { store?: DraftStore; maxRuns?: number } = {},
) {
  const store = options.store ?? harness.store;
  const marks: string[] = [];
  const failed: { draftId: string; cause: unknown }[] = [];
  const diagnostics: DraftProjectionDiagnostics = {
    projectionFailed: (input) => void failed.push(input),
  };
  let projection: ReturnType<typeof createDraftProjection> | undefined;
  const coordinator = phase4Coordinator(harness, {
    store,
    onAppendCommitted(draftId) {
      marks.push(draftId);
      projection?.markDirty(draftId);
    },
  });
  const pulls = createDraftPullService({
    outsideTransaction: (operation) => operation(),
    drafts: harness.store,
    liveJournal: harness.persistence.journal,
    draftCoordinator: coordinator,
  });
  projection = createDraftProjection({
    coordinator,
    store,
    diagnostics,
    outsideTransaction: runOutsideWrite,
    maxRuns: options.maxRuns ?? 4,
  });
  const job = projection;
  return {
    coordinator,
    pulls,
    marks,
    failed,
    projection: () => job,
    dispose() {
      job.dispose();
      pulls.cancelScheduledPulls();
    },
  };
}

/** `has_effect` against the draft's own committed review base. */
export async function judgedEffect(harness: Harness, draftId: string): Promise<boolean> {
  const doc = await durableDoc(harness, draftId);
  const schema = buildDocumentSchema();
  try {
    return !blocksEqual(
      readBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
      readBlocks(doc.getXmlFragment("prosemirror"), schema),
    );
  } finally {
    doc.destroy();
  }
}

/** `store` whose `writeEffect` outcomes are counted. */
export function countingEffects(store: DraftStore) {
  const outcomes: Record<EffectWrite, number> = { written: 0, moved: 0, contended: 0 };
  const counted: DraftStore = {
    ...store,
    async writeEffect(input) {
      const outcome = await store.writeEffect(input);
      outcomes[outcome] += 1;
      return outcome;
    },
  };
  return { store: counted, outcomes };
}

/** `promise`, or a failure naming `what` after `ms`: a wait that must not hang a failing run. */
export async function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
