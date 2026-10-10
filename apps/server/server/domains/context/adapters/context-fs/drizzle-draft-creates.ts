/**
 * Postgres draft creates for one source: the tree owner's hidden-node lifecycle with the
 * collab half injected (the draft's branch is ensured and retracted by collab, which owns
 * branch lifecycle, journals and pooled cores).
 */
import type { Database } from "@meridian/database";
import type { BranchPeerShadowAccess, MarkdownDocumentStore } from "../../../collab/index.js";
import type { DraftCreatePort } from "../../ports/draft-create.js";
import { createInDraft } from "../../tree/creates.js";
import { retractCreate } from "../../tree/end-use.js";

export function createDrizzleDraftCreates(deps: {
  db: Database;
  /** The source, provisioned when the first create needs it. */
  sourceId(): Promise<string>;
  documents: Pick<MarkdownDocumentStore, "ensureDocument">;
  branches: Pick<BranchPeerShadowAccess, "ensureCreatedDraftBranch" | "retractCreatedDraftBranch">;
}): DraftCreatePort {
  return {
    async createInDraft({ draft, dir, name, extension, node }) {
      return createInDraft(deps.db, {
        draftId: draft.id,
        contextSourceId: await deps.sourceId(),
        dir,
        name,
        extension,
        node,
        ensureEmptyContent: (documentId) => deps.documents.ensureDocument(documentId),
        ensureDraftBranch: (documentId) =>
          deps.branches.ensureCreatedDraftBranch({ documentId, workId: draft.workId }),
      });
    },
    async retractCreate({ draft, documentId }) {
      const retracted = await retractCreate(deps.db, {
        draftId: draft.id,
        documentId,
        retractBranch: () =>
          deps.branches.retractCreatedDraftBranch({ documentId, workId: draft.workId }),
      });
      return retracted.retracted ? "retracted" : "stands";
    },
  };
}
