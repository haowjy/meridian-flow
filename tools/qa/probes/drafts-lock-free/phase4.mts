/**
 * What the phase 4 probes share (design `phase4-crdt-appends.md`, §9): the contract they drive
 * (the close code, the outcomes, the store doors and the projection job, named as the design
 * names them), readers of the journal, receipts and effect columns, and the pauses that order
 * two writers by a hook or a held call rather than by a sleep.
 *
 * A seam the design names but the checkout does not have yet fails its probe with
 * `Phase 4 seam missing: …`, not the whole runner: lane-1 modules load through `loadSeam`.
 */
import { WS_CLOSE } from "@meridian/contracts/protocol";
import type { WorkId } from "@meridian/contracts/runtime";
import { createBranchCoordinator } from "../../../../apps/server/server/domains/collab/domain/branch-coordinator.ts";
import {
  type BranchStore,
  materializeBranchRead,
} from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
import {
  type CollabHookPoint,
  setCollabHook,
} from "../../../../apps/server/server/domains/collab/domain/collab-test-hooks.ts";
import { gate, type Harness, settled, Y } from "./harness.mts";

/** The resync close: not a refusal, never counted by the client (design §2.7, D30). */
export const PREFIX_MISSING_CLOSE = { code: 4207, reason: "branch-prefix-missing" } as const;
/** A genuine admission refusal, bounded by the client at three in a row (#940). */
export const REFUSED_CLOSE = { code: 1008, reason: "branch-update-admission-failed" } as const;

export class Phase4SeamMissing extends Error {
  constructor(seam: string) {
    super(`Phase 4 seam missing: ${seam} (design phase4-crdt-appends §8.2)`);
    this.name = "Phase4SeamMissing";
  }
}

/** `WS_CLOSE.BRANCH_PREFIX_MISSING` as the contracts package declares it. */
export function prefixMissingConstant(): { code: number; reason: string } {
  const constant = (WS_CLOSE as Record<string, { code: number; reason: string } | undefined>)
    .BRANCH_PREFIX_MISSING;
  if (!constant) throw new Phase4SeamMissing("WS_CLOSE.BRANCH_PREFIX_MISSING");
  return constant;
}

/** A module lane 1 adds; loaded by path so its absence fails one probe, not the runner. */
export async function loadSeam<T>(relativeToRepo: string, seam: string): Promise<T> {
  const url = new URL(`../../../../${relativeToRepo}`, import.meta.url).href;
  try {
    return (await import(url)) as T;
  } catch (cause) {
    if ((cause as { code?: string }).code === "ERR_MODULE_NOT_FOUND")
      throw new Phase4SeamMissing(seam);
    throw cause;
  }
}

export type EffectWrite = "written" | "moved" | "contended";

/** The store doors phase 4 adds (§3.2, §8.2). */
export type Phase4Store = BranchStore & {
  writeEffect(input: {
    branchId: string;
    revision: number;
    hasEffect: boolean;
    workId: WorkId | null;
  }): Promise<EffectWrite>;
  staleEffectBranches(input: {
    after?: { updatedAt: Date; id: string };
    limit: number;
  }): Promise<readonly { id?: string; branchId?: string; updatedAt: Date }[]>;
};

export function phase4Store(store: BranchStore): Phase4Store {
  for (const door of ["writeEffect", "staleEffectBranches"] as const)
    if (typeof (store as Partial<Phase4Store>)[door] !== "function")
      throw new Phase4SeamMissing(`BranchStore.${door}`);
  return store as Phase4Store;
}

/** The projection job (§3.2): `createBranchProjection` in `domain/branch-projection.ts`. */
export type BranchProjection = {
  markDirty(branchId: string): void;
  sweep(): Promise<void>;
  dispose(): void;
};

export type ProjectionDiagnostics = {
  projectionFailed(input: { branchId: string; cause: unknown }): void;
  projectionBaselineBlocked(input: { branchId: string; documentId: string }): void;
};

type ProjectionModule = {
  createBranchProjection(input: {
    coordinator: unknown;
    store: BranchStore;
    pulls: unknown;
    diagnostics?: ProjectionDiagnostics;
    maxRuns?: number;
  }): BranchProjection;
};

export async function loadProjection(): Promise<ProjectionModule["createBranchProjection"]> {
  const module = await loadSeam<Partial<ProjectionModule>>(
    "apps/server/server/domains/collab/domain/branch-projection.ts",
    "domain/branch-projection.ts",
  );
  if (!module.createBranchProjection) throw new Phase4SeamMissing("createBranchProjection");
  return module.createBranchProjection;
}

/**
 * A coordinator over `store` with phase 4's required `onAppendCommitted` (§3.1) and any other
 * input; the cast keeps this compiling on both sides of lane 1.
 */
export function phase4Coordinator(
  harness: Harness,
  input: {
    store?: BranchStore;
    onAppendCommitted?: (branchId: string) => void;
    onBranchUpdate?: (input: { branchId: string; update: Uint8Array }) => void;
    diagnostics?: Record<string, (...args: never[]) => void>;
  } = {},
) {
  const noop = () => {};
  return createBranchCoordinator({
    store: input.store ?? harness.store,
    attemptScope: harness.attemptScope,
    onAppendCommitted: input.onAppendCommitted ?? noop,
    ...(input.onBranchUpdate ? { onBranchUpdate: input.onBranchUpdate } : {}),
    diagnostics: {
      frameRetried: noop,
      compactionFailed: noop,
      roomReconciled: noop,
      projectionFailed: noop,
      projectionBaselineBlocked: noop,
      appendPrefixMissing: noop,
      ...input.diagnostics,
    },
  } as unknown as Parameters<typeof createBranchCoordinator>[0]);
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
  if (result.name === "BranchPrefixMissingError") return "prefixMissing";
  return { refused: result.name, message: result.message };
}

/** The branch's journal rows of every generation, in id order. */
export async function journalRows(harness: Harness, branchId: string) {
  const rows = await harness.raw<
    { id: string; source: string; update_data: Uint8Array; update_meta: unknown }[]
  >`select id, source, update_data, update_meta from branch_write_journal
    where branch_id = ${branchId} order by id`;
  return rows.map((row) => ({
    id: Number(row.id),
    source: row.source,
    update: new Uint8Array(row.update_data),
    meta: (row.update_meta ?? {}) as { restorationAliases?: unknown[] } & Record<string, unknown>,
  }));
}

type Range = { client: number; clock: number; len: number };

/** Every receipt on the branch's rows: one entry per `document_edits` row, parts in order. */
export async function receipts(harness: Harness, branchId: string) {
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
    join branch_write_journal j on j.id = (p.origin->>'rowId')::bigint
    where p.origin->>'kind' = 'pending' and j.branch_id = ${branchId}
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

/** The branch row's sequence and projection columns; `watermark` is null before 0064. */
export async function branchRow(harness: Harness, branchId: string) {
  const [row] = await harness.raw<Record<string, unknown>[]>`
    select * from document_branches where id = ${branchId}`;
  if (!row) throw new Error(`Branch ${branchId} is missing`);
  return {
    revision: Number(row.revision),
    checkpointSeq: Number(row.checkpoint_seq),
    hasEffect: Boolean(row.has_effect),
    watermark: row.has_effect_revision === undefined ? null : Number(row.has_effect_revision),
    liveCutStored: row.live_cut !== null,
    updatedAt: row.updated_at as Date,
  };
}

/** The structs an update carries, as `client:clock+len`. */
export function structsOf(update: Uint8Array): string[] {
  return Y.decodeUpdate(update).structs.map(
    (struct) => `${struct.id.client}:${struct.id.clock}+${struct.length}`,
  );
}

/** A paused point: the first caller to reach it waits for `release`; later callers pass. */
export function pauseAt(point: CollabHookPoint) {
  const entered = gate();
  const release = gate();
  let held = false;
  const remove = setCollabHook(point, async () => {
    if (held) return;
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
 * before it takes the branch row: "A read at r; B commits; A appends".
 */
export function pausedAppend(store: BranchStore) {
  const entered = gate();
  const release = gate();
  let held = false;
  const paused: BranchStore = {
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

/** A fresh Work, its draft and one document over `text`, with the draft's branch ensured. */
export async function seedDraft(harness: Harness, label: string, text = "Base") {
  const work = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, text);
  const branch = await harness.store.ensureDraftBranch({
    documentId,
    draftId: work.draftId,
    liveDoc: live,
  });
  const { generation } = await harness.readBranch(branch.branchId);
  return { ...work, documentId, live, branchId: branch.branchId, generation };
}

type Frames = {
  commitWriterUpdate: ReturnType<typeof createBranchCoordinator>["commitWriterUpdate"];
};

/**
 * One tab's room in one process: frames go through `coordinator` as the gateway sends them,
 * and an admitted one is applied to the room as Hocuspocus applies it.
 */
export async function openRoom(
  harness: Harness,
  coordinator: Frames,
  draft: { branchId: string; generation: number },
) {
  const room = await durableDoc(harness, draft.branchId);
  return {
    room,
    async send(update: Uint8Array): Promise<FrameOutcome> {
      const outcome = await frameOutcome(
        coordinator.commitWriterUpdate({
          branchId: draft.branchId,
          expectedGeneration: draft.generation,
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

/** The branch as committed now, materialized; the caller destroys it. */
export async function durableDoc(harness: Harness, branchId: string): Promise<Y.Doc> {
  const read = await harness.store.readBranchAt(branchId);
  if (!read) throw new Error(`Branch ${branchId} is missing`);
  return materializeBranchRead(read);
}
