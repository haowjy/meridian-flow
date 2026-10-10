/**
 * The review service's minimal view of a draft's tree (contract §9.1's review bridge):
 * which documents the Work's draft created that are still hidden, and Apply's reveal of
 * one at the draft's location before its text is pushed. Lane E replaces the reveal with
 * the tree step inside one publication; lane D replaces the discard half.
 */
import type { WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { requireLockedActiveWorks } from "../../../shared/work-lifecycle-lock.js";
import { lockContextSources } from "../../context/adapters/context-fs/document-locations.js";
import { dropDraftSettlements } from "../../context/adapters/link-ahead-draft-settlements.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import { dropDocumentRows } from "../../context/tree/draft-tree-store.js";
import { place } from "../../context/tree/hidden-nodes.js";
import { createTreeReader } from "../../context/tree/tree-view.js";
import type { Drafts } from "../domain/drafts.js";
import type { DraftTreeReviewBridge } from "../domain/work-draft-review-service.js";

export function createDrizzleDraftTreeReviewBridge(
  db: Database,
  deps: {
    drafts: Pick<Drafts, "activeForWork" | "lockActive">;
    arrivals?: DocumentArrivals;
  },
): DraftTreeReviewBridge {
  const tree = createTreeReader(db);
  return {
    async createdHidden(workId) {
      const draft = await deps.drafts.activeForWork(workId);
      if (!draft) return new Set();
      return new Set(
        (await tree.treeState(draft.id))
          .filter((item) => item.origin === "created" && item.hidden)
          .map((item) => item.nodeId),
      );
    },
    async activeDraftId(workId) {
      return (await deps.drafts.activeForWork(workId))?.id ?? null;
    },
    async revealCreated({ workId, documentId }) {
      await runInDrizzleTransaction(db, async () => {
        await requireLockedActiveWorks(db, [workId as WorkId]);
        const active = await deps.drafts.activeForWork(workId);
        const draft = active ? await deps.drafts.lockActive(active.id) : null;
        if (!draft) return;
        const item = (await tree.treeState(draft.id)).find(
          (node) => node.nodeId === documentId && node.origin === "created",
        );
        if (!item?.hidden) return;
        await lockContextSources(db, [item.target.contextSourceId, item.live.contextSourceId]);
        await lockDocumentMutation(currentDrizzleDb(db), documentId);
        const placed = await place(db, {
          targets: [
            {
              node: { kind: "document", id: documentId },
              at: {
                contextSourceId: item.target.contextSourceId,
                parentFolderId: item.target.parentFolderId,
                name: item.target.name,
                extension: item.target.extension,
              },
              mode: "reveal",
            },
          ],
        });
        if (!placed.ok) {
          throw new Error(
            placed.error.code === "path_taken"
              ? `Another file holds ${placed.error.at}; the new file can't be applied there`
              : `New file ${documentId} changed before it could be applied`,
          );
        }
        await dropDocumentRows(db, { draftId: draft.id, documentIds: [documentId] });
        await dropDraftSettlements(db, { draftId: draft.id, documentIds: [documentId] });
        await deps.arrivals?.settle([documentId]);
      });
    },
  };
}
