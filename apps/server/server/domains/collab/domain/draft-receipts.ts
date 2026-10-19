/**
 * An append's finalization under the draft row lock (design §2.2): every fact that depends on
 * the committed prefix is decided here, against what is committed, and nowhere before the lock.
 * The store calls it with its post-lock read; it returns the rows to insert (their novel bytes)
 * and their receipts, or why nothing is written.
 */

import {
  DRAFT_SERVER_CLIENT_ID,
  findLostEdits,
  type LateTyping,
  NO_LATE_TYPING,
  recoverLatePeerEdits,
  retainLateTypingDeletions,
} from "@meridian/agent-edit/diff";
import { captureEditParts, type EditFrontier } from "@meridian/agent-edit/integration";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
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
import { validateClientUpdateAdmission, validateRestorationRanges } from "./provenance.js";

// LateTyping retains PM nodes between frames; their schema identity must remain stable.
const recoverySchema = buildDocumentSchema();

/** Runs under the row hold, after incoming rows. Capture each server transaction
 * as an update and return it in order. The runtime owns and destroys this private prefix copy. */
export type AuthorServerRows = (
  prefix: Y.Doc,
) => readonly Uint8Array[] | Promise<readonly Uint8Array[]>;

export type FinalizeAppendInput = {
  work?: "active" | "any";
  authorServerRows?: AuthorServerRows;
  recovery?: {
    memory(): LateTyping;
    serverDeletedBlocks(ids: readonly Y.ID[]): Promise<ReadonlySet<string>>;
  };
  /**
   * A private clone of the caller's base replica, made off the lock. When the checkpoint held
   * it becomes the committed prefix; when a rewrite moved it, it is destroyed.
   */
  candidate: Y.Doc;
  rows: readonly AppendDraftJournalInput[];
  containment: ReturnType<typeof createDocumentContainment>;
  /**
   * A writer row's authorship on the committed prefix, even when preflight judged the same
   * base. Every incoming writer row crosses this boundary under the row hold.
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
  lateTyping?: LateTyping;
};

/**
 * Builds the committed prefix from `read`, judges each row on its before-view (containment,
 * the novel trim, held deletes, restoration ranges, and client admission on the committed prefix),
 * applies them requiring complete integration, and captures one receipt per logical write on
 * the final document. Any outcome but `appended` leaves `doc` unusable: the caller destroys it.
 */
export async function finalizeAppend(
  read: DraftRead,
  input: FinalizeAppendInput,
): Promise<{ finalization: AppendFinalization; doc: Y.Doc; result?: FinalizedAppend }> {
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
  try {
    const done = (finalization: AppendFinalization) => ({ finalization, doc });
    if (input.work !== "any" && read.documentDraft.lifecycle !== "active")
      return done({ status: "refused" });

    let lateTyping = input.recovery?.memory() ?? NO_LATE_TYPING;
    const kept: { row: AppendDraftJournalInput; frontier: EditFrontier; held: Set<string> }[] = [];
    function admit(row: AppendDraftJournalInput): AppendFinalization | undefined {
      if (input.containment.contains(doc, row.updateData)) return;
      const stateVector = Y.encodeStateVector(doc);
      const novel = Y.diffUpdate(row.updateData, stateVector);
      const frontier = Y.decodeStateVector(stateVector);
      const held = heldDeletes(doc, novel, frontier);
      if (row.source === "writer") input.validateWriter(doc, novel);
      if (row.source === "agent") {
        assertFreshAgentUpdate(doc, novel);
        validateClientUpdateAdmission(doc, novel);
      }
      Y.applyUpdate(doc, novel);
      const missing = pendingClocks(doc);
      if (missing.length) return { status: "prefixMissing", clocks: missing };
      if (row.source !== "server") validateRestorationRanges(doc, novel);
      kept.push({
        row: { ...row, updateData: novel },
        frontier: Object.fromEntries(frontier),
        held,
      });
    }
    for (const row of input.rows) {
      const lost =
        row.source === "server" || !input.recovery
          ? { typed: [], deleted: [] }
          : findLostEdits(doc, row.updateData);
      const refused = admit(row);
      if (refused) return done(refused);
      if (input.recovery && (lost.typed.length || lost.deleted.length)) {
        const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        const blocks = new Map<string, Y.ID>();
        const blockOf = (id: Y.ID): Y.ID | null => {
          let item: Y.Item | Y.GC | null = Y.getItem(doc.store, id);
          while (item instanceof Y.Item) {
            const parent = item.parent as Y.AbstractType<unknown>;
            if (parent === fragment) return item.id;
            item = parent._item;
          }
          return null;
        };
        for (const edit of lost.typed) {
          const id = blockOf(edit.id);
          if (id) blocks.set(`${id.client}:${id.clock}`, id);
        }
        const deleted = blocks.size
          ? await input.recovery.serverDeletedBlocks([...blocks.values()])
          : new Set<string>();
        const typed = lost.typed.filter((edit) => {
          const block = blockOf(edit.id);
          return block && deleted.has(`${block.client}:${block.clock}`);
        });
        {
          // Without typing the helper only advances deletion memory; no clone or server row.
          const authoring = typed.length ? createCollabYDoc({ gc: false }) : doc;
          try {
            if (authoring !== doc) Y.applyUpdate(authoring, Y.encodeStateAsUpdate(doc));
            const recovery = recoverLatePeerEdits({
              doc: authoring,
              update: row.updateData,
              lost: { ...lost, typed },
              memory: retainLateTypingDeletions(lateTyping, input.recovery.memory()),
              schema: recoverySchema,
              fragmentName: PROSEMIRROR_FRAGMENT_NAME,
              clientId: DRAFT_SERVER_CLIENT_ID,
            });
            lateTyping = recovery.memory;
            if (recovery.update) {
              const refused = admit({
                draftId: row.draftId,
                source: "server",
                updateData: recovery.update,
              });
              if (refused) return done(refused);
            }
          } finally {
            if (authoring !== doc) authoring.destroy();
          }
        }
      }
    }
    if (input.authorServerRows) {
      // Authoring must not mutate the receipt before-view. This copy is made only for server
      // operations, under the hold, so client 1 allocates clocks after every committed row.
      const authoring = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(authoring, Y.encodeStateAsUpdate(doc));
        authoring.clientID = DRAFT_SERVER_CLIENT_ID;
        for (const updateData of await input.authorServerRows(authoring)) {
          const refused = admit({
            draftId: read.documentDraft.draftId,
            source: "server",
            updateData,
          });
          if (refused) return done(refused);
        }
      } finally {
        authoring.destroy();
      }
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
        lateTyping,
      },
    };
  } catch (cause) {
    // A moved checkpoint materialized a new owned prefix that the caller has not received.
    if (doc !== input.candidate) doc.destroy();
    throw cause;
  }
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
