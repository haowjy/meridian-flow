/**
 * Read-only repeatable-read review capture (contract §3.2): the branch, the live journal, the
 * item as the identity module resolves it, and both link views, all from one snapshot. A
 * document the draft only edited and whose branch has no effect still has a cut (G+1).
 */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import {
  assertReadableBranch,
  type BranchStore,
  materializeBranchRead,
} from "../domain/branch-coordinator.js";
import {
  type BranchJournalReadStore,
  DraftChangeRefusal,
} from "../domain/branch-push-contracts.js";
import { BranchCorruptError } from "../domain/branch-resolver.js";
import type { DraftReviewIdentity } from "../domain/draft-review-identity.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "../domain/ports/document-link-scope.js";
import type { ReadReviewCut } from "../domain/ports/review-cut.js";
import { readLiveReviewRevision } from "./drizzle-draft-review-live.js";

export function createDrizzleReviewCut(input: {
  db: Database;
  journal: UpdateJournal;
  branches: BranchStore;
  rows: BranchJournalReadStore;
  links: DocumentLinkScopes;
  identity: DraftReviewIdentity;
  resolveThreadTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}): ReadReviewCut {
  return (address) =>
    runInRootDrizzleReadSnapshot(input.db, async () => {
      // The first read fixes the database snapshot. Live journal replay below is
      // database-only and joins it, so no room/network wait holds this snapshot.
      const resolved = await input.identity.resolveReviewItem(address);
      if (!resolved?.draftBranchId) throw new DraftChangeRefusal("gone");
      const read = await input.branches.readBranchAt(resolved.draftBranchId);
      const branch = read?.branch;
      if (
        !read ||
        branch?.kind !== "work_draft" ||
        branch.status !== "active" ||
        branch.draftId !== resolved.draftId ||
        branch.documentId !== resolved.documentId
      )
        throw new DraftChangeRefusal("gone");
      assertReadableBranch(branch);
      const live = await input.journal.read(resolved.documentId);
      const revision = await readLiveReviewRevision(
        currentDrizzleDb(input.db),
        resolved.documentId,
      );
      const history = await input.rows.listJournalRowsForBranch({
        branchId: branch.branchId,
        generation: branch.generation,
      });
      const liveDoc = materialize(live);
      let draftDoc: Y.Doc;
      try {
        draftDoc = materializeBranchRead(read);
      } catch (cause) {
        liveDoc.destroy();
        throw new BranchCorruptError({
          branchId: branch.branchId,
          documentId: branch.documentId,
          generation: branch.generation,
          cause,
        });
      }
      // The cut's own bytes, detached before the link scope binds the document.
      const state =
        read.tail.length === 0 && read.checkpoint
          ? read.checkpoint.state
          : Y.encodeStateAsUpdate(draftDoc);
      try {
        const draftView = { kind: "draft" as const, draftId: resolved.draftId };
        return await input.links.within({ documentId: resolved.documentId }, async () => {
          await input.links.prepare({
            holders: [
              { documentId: resolved.documentId, view: LIVE_VIEW },
              { documentId: resolved.documentId, view: draftView },
            ],
            docs: [liveDoc, draftDoc],
          });
          const threadTitles = await input.resolveThreadTitles([
            ...new Set(history.flatMap((row) => (row.threadId ? [row.threadId] : []))),
          ]);
          return {
            branch: { ...branch, state },
            history,
            live: { state: Y.encodeStateAsUpdate(liveDoc), revision },
            item: resolved.item,
            links: {
              live: input.links.holder({ documentId: resolved.documentId, view: LIVE_VIEW }),
              draft: input.links.holder({ documentId: resolved.documentId, view: draftView }),
            },
            threadTitles,
          };
        });
      } finally {
        liveDoc.destroy();
        draftDoc.destroy();
      }
    });
}

/** The live document as the current transaction's snapshot sees it, journal replay only. */
export async function readLiveDoc(journal: UpdateJournal, documentId: string) {
  return materialize(await journal.read(documentId as never));
}

function materialize(snapshot: Awaited<ReturnType<UpdateJournal["read"]>>) {
  const doc = createCollabYDoc({ gc: false });
  try {
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  } catch (cause) {
    doc.destroy();
    throw cause;
  }
}
