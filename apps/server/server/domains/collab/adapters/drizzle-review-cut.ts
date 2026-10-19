/**
 * Read-only repeatable-read review capture (contract §3.2): the draft, the live journal, the
 * item as the identity module resolves it, and both link views, all from one snapshot. A
 * document the branch only edited and whose draft has no effect still has a cut (G+1).
 */
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import type { Database } from "@meridian/database";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  currentDrizzleDb,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { DraftChangeRefusal } from "../domain/branch-push-contracts.js";
import type { BranchReviewIdentity } from "../domain/branch-review-identity.js";
import type { DraftJournalReadStore } from "../domain/draft-journal.js";
import { DraftCorruptError } from "../domain/draft-resolver.js";
import {
  assertReadableDraft,
  type DraftStore,
  materializeDraftRead,
} from "../domain/draft-store.js";
import { type DocumentLinkScopes, LIVE_VIEW } from "../domain/ports/document-link-scope.js";
import type { ReadReviewCut } from "../domain/ports/review-cut.js";
import { readHeadRevision } from "./drizzle-document-authority-head.js";

export function createDrizzleReviewCut(input: {
  db: Database;
  journal: UpdateJournal;
  drafts: DraftStore;
  rows: DraftJournalReadStore;
  links: DocumentLinkScopes;
  identity: BranchReviewIdentity;
  resolveThreadTitles(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}): ReadReviewCut {
  return (address) =>
    runInRootDrizzleReadSnapshot(input.db, async () => {
      // The first read fixes the database snapshot. Live journal replay below is
      // database-only and joins it, so no room/network wait holds this snapshot.
      const resolved = await input.identity.resolveReviewItem(address);
      if (!resolved?.draftId) throw new DraftChangeRefusal("gone");
      const read = await input.drafts.readDraftAt(resolved.draftId);
      const documentDraft = read?.documentDraft;
      if (
        !read ||
        documentDraft?.kind !== "work_draft" ||
        documentDraft.status !== "active" ||
        documentDraft.branchId !== resolved.branchId ||
        documentDraft.documentId !== resolved.documentId
      )
        throw new DraftChangeRefusal("gone");
      assertReadableDraft(documentDraft);
      const live = await input.journal.read(resolved.documentId);
      const revision = await readHeadRevision(currentDrizzleDb(input.db), resolved.documentId);
      const history = await input.rows.listJournalRowsForDraft({
        draftId: documentDraft.draftId,
        generation: documentDraft.generation,
      });
      const liveDoc = materialize(live);
      let draftDoc: Y.Doc;
      try {
        draftDoc = materializeDraftRead(read);
      } catch (cause) {
        liveDoc.destroy();
        throw new DraftCorruptError({
          draftId: documentDraft.draftId,
          documentId: documentDraft.documentId,
          generation: documentDraft.generation,
          cause,
        });
      }
      // The cut's own bytes, detached before the link scope binds the document.
      const state =
        read.tail.length === 0 && read.checkpoint
          ? read.checkpoint.state
          : Y.encodeStateAsUpdate(draftDoc);
      try {
        const branchView = { kind: "branch" as const, branchId: resolved.branchId };
        return await input.links.within({ documentId: resolved.documentId }, async () => {
          await input.links.prepare({
            holders: [
              { documentId: resolved.documentId, view: LIVE_VIEW },
              { documentId: resolved.documentId, view: branchView },
            ],
            docs: [liveDoc, draftDoc],
          });
          const threadTitles = await input.resolveThreadTitles([
            ...new Set(history.flatMap((row) => (row.threadId ? [row.threadId] : []))),
          ]);
          return {
            documentDraft: { ...documentDraft, state },
            history,
            live: { state: Y.encodeStateAsUpdate(liveDoc), revision },
            item: resolved.item,
            links: {
              live: input.links.holder({ documentId: resolved.documentId, view: LIVE_VIEW }),
              draft: input.links.holder({ documentId: resolved.documentId, view: branchView }),
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
