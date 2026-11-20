/**
 * An append's finalization under the draft row lock (design §2.2): every fact that depends on
 * the committed prefix is decided here, against what is committed, and nowhere before the lock.
 * The store calls it with its post-lock read; it returns the rows to insert (their novel bytes)
 * and their receipts, or why nothing is written.
 */

import { captureDelta, type StoredDelta } from "@meridian/agent-edit/content-merge";
import { DRAFT_SERVER_CLIENT_ID, readBlocks } from "@meridian/agent-edit/diff";
import {
  captureEditParts,
  heldDeletes,
  type SaveCut,
  type SavePrecondition,
} from "@meridian/agent-edit/integration";
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
import { DraftSaveCut } from "./immutable-draft-state.js";
import { validateClientUpdateAdmission } from "./provenance.js";

// An AI write's receipt reads the text on each side of it; the schema's identity must stay stable.
const deltaSchema = buildDocumentSchema();

/** Runs under the row hold, after incoming rows. Capture each server transaction
 * as an update and return it in order. The runtime owns and destroys this private prefix copy. */
export type AuthorServerRows = (
  prefix: Y.Doc,
) => readonly Uint8Array[] | Promise<readonly Uint8Array[]>;

export type FinalizeAppendInput = {
  /** Judged on the committed prefix before any incoming or server-authored row. */
  precondition?: SavePrecondition;
  work?: "active" | "any";
  authorServerRows?: AuthorServerRows;
  /** What the rows `authorServerRows` writes carry: who made them and, for an Undo, what they took back. */
  serverRow?: () => Partial<Omit<AppendDraftJournalInput, "draftId" | "source" | "updateData">>;
  /**
   * A private clone of the caller's base replica, made off the lock. When the checkpoint held
   * it becomes the committed prefix; when a rewrite moved it, it is destroyed.
   */
  candidate: Y.Doc;
  /** The immutable base encoding already used to clone candidate. */
  candidateState: Uint8Array;
  rows: readonly AppendDraftJournalInput[];
  containment: ReturnType<typeof createDocumentContainment>;
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
 * the novel trim, held deletes and client admission on the committed prefix),
 * applies them requiring complete integration, and captures one receipt per logical write on
 * the final document. Any outcome but `appended` leaves `doc` unusable: the caller destroys it.
 * An appended or contained outcome carries its cut: the prefix as found under the lock, and
 * with the kept rows (the same prefix, when every row was contained).
 */
export async function finalizeAppend(
  read: DraftRead,
  input: FinalizeAppendInput,
): Promise<{
  finalization: AppendFinalization;
  doc: Y.Doc;
  cut?: SaveCut;
  result?: FinalizedAppend;
}> {
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

    const before =
      prefixHeld && !read.tail.length ? input.candidateState : Y.encodeStateAsUpdate(doc);
    if (input.precondition && !input.precondition(before))
      return done({ status: "preconditionFailed" });

    const kept: {
      row: AppendDraftJournalInput;
      held: Set<string>;
      delta: StoredDelta | null;
    }[] = [];
    // A writer's row can wait on another tab's edit that has not reached the journal yet. That
    // wait is the writer row's, not this append's: only what these rows leave pending refuses.
    const waiting = new Set(pendingClocks(doc).map(clockKey));
    function admit(row: AppendDraftJournalInput): AppendFinalization | undefined {
      if (input.containment.contains(doc, row.updateData)) return;
      const stateVector = Y.encodeStateVector(doc);
      const novel = Y.diffUpdate(row.updateData, stateVector);
      const held = heldDeletes(doc, novel, Y.decodeStateVector(stateVector));
      if (row.source === "agent") {
        assertFreshAgentUpdate(doc, novel);
        validateClientUpdateAdmission(doc, novel);
      }
      // What an AI write did to the text, read once on each side of it: the card and the model's
      // Undo read the edit from this, not from Yjs ids.
      const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      const textBefore = row.source === "agent" ? readBlocks(fragment, deltaSchema) : null;
      Y.applyUpdate(doc, novel);
      const missing = pendingClocks(doc).filter((clock) => !waiting.has(clockKey(clock)));
      if (missing.length) return { status: "prefixMissing", clocks: missing };
      kept.push({
        row: { ...row, updateData: novel },
        held,
        delta: textBefore ? captureDelta(textBefore, readBlocks(fragment, deltaSchema)) : null,
      });
    }
    for (const row of input.rows) {
      const refused = admit(row);
      if (refused) return done(refused);
    }
    if (input.authorServerRows) {
      // Authoring must not mutate the receipt before-view. This copy is made only for server
      // operations, under the hold, so client 1 allocates clocks after every committed row.
      const authoring = createCollabYDoc({ gc: false });
      try {
        Y.applyUpdate(authoring, kept.length ? Y.encodeStateAsUpdate(doc) : before);
        authoring.clientID = DRAFT_SERVER_CLIENT_ID;
        for (const updateData of await input.authorServerRows(authoring)) {
          const refused = admit({
            ...input.serverRow?.(),
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
    if (!kept.length)
      return { ...done({ status: "contained" }), cut: { beforeState: before, afterState: before } };

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
          held: kept[index].held,
        })),
      ).map((part, i) => ({ ...part, delta: kept[rowIndexes[i]].delta })),
    }));
    const rows = kept.map((entry) => entry.row);
    // Finalization is over: this document is immutable for both the save cut and the replica.
    return {
      finalization: { status: "appended", rows, receipts },
      doc,
      cut: new DraftSaveCut(before, doc),
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
  } catch (cause) {
    // A moved checkpoint materialized a new owned prefix that the caller has not received.
    if (doc !== input.candidate) doc.destroy();
    throw cause;
  }
}

const clockKey = ({ client, clock }: { client: number; clock: number }) => `${client}:${clock}`;

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
