/** Test reads and appends straight through a branch store's read seam and its one append door. */
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { readBranchAt } from "../adapters/drizzle-branch-storage.js";
import { finalizeAppend } from "../domain/branch-receipts.js";
import {
  type AppendBranchJournalInput,
  type BranchStore,
  materializeBranchRead,
} from "../domain/branch-store.js";
import { createDocumentContainment } from "../domain/document-containment.js";

/** A valid update that changes nothing: a journal row whose content is irrelevant to the test. */
export const EMPTY_BRANCH_UPDATE = Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));

/** A fresh paragraph of `text` from a new client: a row with a visible effect. */
export function proseBranchUpdate(text = "drafted"): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).insert(0, [paragraph]);
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Appends `rows` (a writer's or an agent's) through the store's one append door, finalized on
 * the committed prefix as a coordinator's append is; the ids come back.
 */
export async function appendBranchRows(
  store: Pick<BranchStore, "readBranchAt" | "appendRows">,
  branchId: string,
  rows: readonly Omit<AppendBranchJournalInput, "branchId" | "generation">[],
): Promise<readonly number[]> {
  const read = await store.readBranchAt(branchId);
  if (!read) throw new Error(`Branch ${branchId} does not exist`);
  const journals = rows.map((row) => ({ ...row, branchId, generation: read.branch.generation }));
  const candidate = materializeBranchRead(read);
  let doc: Y.Doc | undefined;
  try {
    const outcome = await store.appendRows({
      branchId,
      documentId: read.branch.documentId,
      expectedGeneration: read.branch.generation,
      base: {
        checkpointRevision: read.branch.checkpointRevision,
        seq: Math.max(read.branch.checkpointSeq, ...read.tail.map((row) => row.id)),
      },
      finalize(prefix) {
        const judged = finalizeAppend(prefix, {
          candidate,
          rows: journals,
          containment: createDocumentContainment(),
          validateWriter: () => {},
        });
        doc = judged.doc;
        return judged.finalization;
      },
    });
    if (outcome.status !== "appended")
      throw new Error(`Branch ${branchId} append was ${outcome.status}`);
    return outcome.rowIds;
  } finally {
    candidate.destroy();
    doc?.destroy();
  }
}

/**
 * A resolved branch with its content: generation and document come from one read, so a test
 * never pairs one generation's identity with another's content.
 */
export async function readResolvedBranch(
  store: Pick<BranchStore, "readBranchAt">,
  resolved: { branchId: string },
): Promise<{ branchId: string; generation: number; doc: Y.Doc }> {
  const read = await store.readBranchAt(resolved.branchId);
  if (!read) throw new Error(`Branch ${resolved.branchId} does not exist`);
  return {
    branchId: read.branch.branchId,
    generation: read.branch.generation,
    doc: materializeBranchRead(read),
  };
}

/** The branch's content now (checkpoint ⊕ tail), as update bytes. */
export async function readBranchContent(
  store: Pick<BranchStore, "readBranchAt">,
  branchId: string,
): Promise<Uint8Array> {
  const read = await store.readBranchAt(branchId);
  if (!read) throw new Error(`Branch ${branchId} does not exist`);
  const doc = materializeBranchRead(read);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** The branch's content as the database holds it (checkpoint ⊕ tail), read through the seam. */
export async function branchContent(db: DrizzleDb, branchId: string): Promise<Uint8Array> {
  const read = await readBranchAt(db, branchId);
  if (!read) throw new Error(`Branch ${branchId} does not exist`);
  const doc = materializeBranchRead(read);
  try {
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}
