/**
 * An append's finalization under the draft row lock (design §2.2): every fact that depends on
 * the committed prefix is decided here, against what is committed, and nowhere before the lock.
 * The store calls it with its post-lock read; it returns the rows to insert (their novel bytes)
 * and their receipts, or why nothing is written.
 */
import { captureEditParts, type EditFrontier } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { createDocumentContainment } from "./document-containment.js";
import { assertFreshAgentUpdate } from "./document-mutation-policy.js";
import {
  type AppendDraftJournalInput,
  type AppendFinalization,
  type AppendReceiptGroup,
  type DraftRead,
  type DraftTailRow,
  materializeDraftRead,
} from "./draft-store.js";
import { certifyWriterRestorations } from "./writer-restoration.js";

export type FinalizeAppendInput = {
  /**
   * A private clone of the caller's base replica, made off the lock. When the checkpoint held
   * it becomes the committed prefix; when a rewrite moved it, it is destroyed.
   */
  candidate: Y.Doc;
  rows: readonly AppendDraftJournalInput[];
  containment: ReturnType<typeof createDocumentContainment>;
  /**
   * A writer row's authorship on the committed prefix. Called only when the prefix moved past
   * the base the pre-lock check judged; throws the authorship errors.
   */
  validateWriter(prefix: Y.Doc, update: Uint8Array): void;
};

/** A finalized append: what the store inserts, and the document it commits into. */
export type FinalizedAppend = Extract<AppendFinalization, { status: "appended" }> & {
  /** The committed prefix with every kept row applied. */
  doc: Y.Doc;
  /** The checkpoint the base held is still the draft's: `prefixRows` are the rows between. */
  prefixHeld: boolean;
  prefixRows: readonly DraftTailRow[];
  checkpointSeq: number;
};

/**
 * Builds the committed prefix from `read`, judges each row on its before-view (containment,
 * the novel trim, held deletes, the restoration certificate, authorship when the prefix moved),
 * applies them requiring complete integration, and captures one receipt per logical write on
 * the final document. Any outcome but `appended` leaves `doc` unusable: the caller destroys it.
 */
export function finalizeAppend(
  read: DraftRead,
  input: FinalizeAppendInput,
): { finalization: AppendFinalization; doc: Y.Doc; result?: FinalizedAppend } {
  const prefixHeld = read.checkpoint === null;
  let doc = input.candidate;
  if (prefixHeld) {
    for (const row of read.tail) {
      if (row.source === "agent") assertFreshAgentUpdate(doc, row.update);
      Y.applyUpdate(doc, row.update);
    }
  } else {
    input.candidate.destroy();
    doc = materializeDraftRead(read);
  }
  const done = (finalization: AppendFinalization) => ({ finalization, doc });
  if (read.documentDraft.lifecycle !== "active") return done({ status: "refused" });
  const moved = !prefixHeld || read.tail.length > 0;

  const kept: { row: AppendDraftJournalInput; frontier: EditFrontier; held: Set<string> }[] = [];
  for (const row of input.rows) {
    if (input.containment.contains(doc, row.updateData)) continue;
    const stateVector = Y.encodeStateVector(doc);
    const novel = Y.diffUpdate(row.updateData, stateVector);
    const frontier = Y.decodeStateVector(stateVector);
    const held = heldDeletes(doc, novel, frontier);
    let updateMeta = row.updateMeta;
    if (row.source === "writer") {
      if (moved) input.validateWriter(doc, novel);
      updateMeta = {
        ...(isRecord(row.updateMeta) ? row.updateMeta : {}),
        restorationAliases: certifyWriterRestorations(doc, novel),
      };
    }
    Y.applyUpdate(doc, novel);
    const missing = pendingClocks(doc);
    if (missing.length) return done({ status: "prefixMissing", clocks: missing });
    kept.push({
      row: { ...row, updateData: novel, updateMeta },
      frontier: Object.fromEntries(frontier),
      held,
    });
  }
  if (!kept.length) return done({ status: "contained" });

  const groups = new Map<string, number[]>();
  for (const [index, { row }] of kept.entries()) {
    const key = row.documentEditKey ?? `${row.threadId}:${row.wId ?? `#${index}`}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  }
  const receipts: AppendReceiptGroup[] = [...groups.values()].map((rowIndexes) => ({
    rowIndexes,
    parts: captureEditParts(
      doc,
      rowIndexes.map((index) => ({
        update: kept[index].row.updateData,
        frontier: kept[index].frontier,
      })),
    ).map((part, i) => {
      // A re-sent delete the prefix already held is not this row's effect.
      const held = kept[rowIndexes[i]].held;
      if (!held.size) return part;
      return {
        ...part,
        effect: { ...part.effect, deleted: withoutClocks(part.effect.deleted, held) },
      };
    }),
  }));
  const rows = kept.map((entry) => entry.row);
  return {
    finalization: { status: "appended", rows, receipts },
    doc,
    result: {
      status: "appended",
      rows,
      receipts,
      doc,
      prefixHeld,
      prefixRows: read.tail,
      checkpointSeq: read.documentDraft.checkpointSeq,
    },
  };
}

/**
 * The clocks of `novel`'s delete set that `doc` already holds deleted. Only the part of each
 * range below the before-frontier names structs `doc` has; a clock at or past it is inserted by
 * this update or unknown, and the apply decides it (integrated, or pending: prefix-missing).
 */
function heldDeletes(doc: Y.Doc, novel: Uint8Array, frontier: Map<number, number>): Set<string> {
  const held = new Set<string>();
  for (const [client, ranges] of Y.decodeUpdate(novel).ds.clients) {
    const known = frontier.get(client) ?? 0;
    for (const { clock, len } of ranges) {
      const end = Math.min(clock + len, known);
      for (let at = clock; at < end; ) {
        const struct = Y.getItem(doc.store, Y.createID(client, at));
        const structEnd = Math.min(struct.id.clock + struct.length, end);
        if (struct.deleted) for (let c = at; c < structEnd; c += 1) held.add(`${client}:${c}`);
        at = structEnd;
      }
    }
  }
  return held;
}

/**
 * What the last apply left pending: the update depends on structs or deletes not yet held.
 * Yjs keeps `pendingDs` in the V2 encoding whatever the applied update used.
 */
function pendingClocks(doc: Y.Doc): { client: number; clock: number }[] {
  const { pendingStructs, pendingDs } = doc.store;
  const clocks = pendingStructs
    ? [...pendingStructs.missing].map(([client, clock]) => ({ client, clock }))
    : [];
  if (pendingDs)
    for (const [client, ranges] of Y.decodeUpdateV2(pendingDs).ds.clients)
      for (const { clock } of ranges) clocks.push({ client, clock });
  return clocks;
}

function withoutClocks<R extends { client: number; clock: number; len: number }>(
  ranges: readonly R[],
  clocks: ReadonlySet<string>,
): R[] {
  const out: R[] = [];
  for (const range of ranges) {
    let start: number | null = null;
    for (let clock = range.clock; clock <= range.clock + range.len; clock += 1) {
      const keep = clock < range.clock + range.len && !clocks.has(`${range.client}:${clock}`);
      if (keep && start === null) start = clock;
      if (!keep && start !== null) {
        out.push({ ...range, clock: start, len: clock - start });
        start = null;
      }
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
