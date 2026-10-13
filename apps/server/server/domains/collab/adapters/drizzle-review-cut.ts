/** Read-only repeatable-read review capture, including the tree and both manifest views. */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { contextSources, documentBranches, documents } from "@meridian/database/schema";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import { and, eq, isNull, sql } from "drizzle-orm";
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
import { type DocumentLinkScopes, LIVE_VIEW } from "../domain/ports/document-link-scope.js";
import type { ReadReviewCut } from "../domain/ports/review-cut.js";
import { readLiveReviewRevision } from "./drizzle-draft-review-live.js";

export function createDrizzleReviewCut(input: {
  db: Database;
  journal: UpdateJournal;
  branches: BranchStore;
  rows: BranchJournalReadStore;
  links: DocumentLinkScopes;
  resolveThreadTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}): ReadReviewCut {
  return (address) =>
    runInRootDrizzleReadSnapshot(input.db, async () => {
      // The first read fixes the database snapshot. Live journal replay below is
      // database-only and joins it, so no room/network wait holds this snapshot.
      const branch = await input.branches.getBranch(address.draftBranchId);
      if (
        branch?.kind !== "work_draft" ||
        branch.status !== "active" ||
        branch.workId !== address.workId ||
        branch.documentId !== address.documentId
      )
        throw new DraftChangeRefusal("gone");
      assertReadableBranch(branch);
      const live = await input.journal.read(address.documentId);
      const revision = await readLiveReviewRevision(currentDrizzleDb(input.db), address.documentId);
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
        const tx = currentDrizzleDb(input.db);
        const [manifest] = await tx
          .select({ id: documents.id })
          .from(documents)
          .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
          .where(
            and(
              eq(
                contextSources.projectId,
                sql`(SELECT project_id FROM works WHERE id = ${address.workId})`,
              ),
              eq(documents.kind, "manifest"),
              isNull(documents.deletedAt),
            ),
          )
          .limit(1);
        let membership = { live: [] as string[], draft: [] as string[] };
        if (manifest) {
          const manifestLive = materialize(await input.journal.read(manifest.id));
          const manifestDraft = createCollabYDoc({ gc: false });
          try {
            const [draft] = await tx
              .select({ state: documentBranches.state })
              .from(documentBranches)
              .where(
                and(
                  eq(documentBranches.documentId, manifest.id),
                  eq(documentBranches.workId, address.workId),
                  eq(documentBranches.kind, "work_draft"),
                  eq(documentBranches.status, "active"),
                ),
              )
              .limit(1);
            Y.applyUpdate(manifestDraft, draft?.state ?? Y.encodeStateAsUpdate(manifestLive));
            membership = { live: members(manifestLive), draft: members(manifestDraft) };
          } finally {
            manifestLive.destroy();
            manifestDraft.destroy();
          }
        }
        const draftView = { kind: "draft" as const, workId: address.workId };
        return await input.links.within(
          {
            documentId: address.documentId,
            memberships: [
              { view: LIVE_VIEW, members: membership.live },
              { view: draftView, members: membership.draft },
            ],
          },
          async () => {
            await input.links.prepare({
              holders: [
                { documentId: address.documentId, view: LIVE_VIEW },
                { documentId: address.documentId, view: draftView },
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
              membership,
              links: {
                live: input.links.holder({ documentId: address.documentId, view: LIVE_VIEW }),
                draft: input.links.holder({ documentId: address.documentId, view: draftView }),
              },
              threadTitles,
            };
          },
        );
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
function members(doc: Y.Doc) {
  return [...doc.getMap("documents").keys()].sort();
}
