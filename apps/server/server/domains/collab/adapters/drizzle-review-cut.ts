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
import { assertReadableBranch, type BranchStore } from "../domain/branch-coordinator.js";
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
      const branch = await input.branches.getBranch(resolved.draftBranchId);
      if (
        branch?.kind !== "work_draft" ||
        branch.status !== "active" ||
        branch.draftId !== resolved.draftId ||
        branch.documentId !== resolved.documentId
      )
        throw new DraftChangeRefusal("gone");
      assertReadableBranch(branch);
      const live = await input.journal.read(resolved.documentId);
      const revision = await readLiveReviewRevision(currentDrizzleDb(input.db), resolved.documentId);
      const history = await input.rows.listJournalRowsForBranch({
        branchId: branch.branchId,
        generation: branch.generation,
      });
      const liveDoc = materialize(live);
      const draftDoc = createCollabYDoc({ gc: false });
      try {
        try {
          Y.applyUpdate(draftDoc, branch.state);
        } catch (cause) {
          throw new BranchCorruptError({
            branchId: branch.branchId,
            documentId: branch.documentId,
            generation: branch.generation,
            cause,
          });
        }
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
            branch,
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
