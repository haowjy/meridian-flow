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
import type { HiddenNodeRepair } from "../../tree/hidden-node-repair.js";
import { lockDocumentNamespaces } from "./document-locations.js";

export function createDrizzleDraftCreates(deps: {
  db: Database;
  /** The source, provisioned when the first create needs it. */
  sourceId(): Promise<string>;
  documents: Pick<MarkdownDocumentStore, "ensureDocument">;
  branches: Pick<BranchPeerShadowAccess, "ensureCreatedDraftBranch" | "retractCreatedDraftBranch">;
  /** Repair on touch: the candidate picker reports what it repaired (§12.4). */
  repair?: Pick<HiddenNodeRepair, "report">;
}): DraftCreatePort {
  /**
   * The source, with its namespace held (§14: after the command's Work and draft, before
   * any document lock). A resolved source id is cached across commands, so the lock is
   * taken here, every command, never left to provisioning.
   */
  async function lockedSource(): Promise<string> {
    const sourceId = await deps.sourceId();
    await lockDocumentNamespaces(deps.db, [], [sourceId]);
    return sourceId;
  }

  return {
    async createInDraft({ draft, dir, name, extension, node }) {
      return createInDraft(deps.db, {
        draftId: draft.id,
        contextSourceId: await lockedSource(),
        dir,
        name,
        extension,
        node,
        ensureEmptyContent: (documentId) => deps.documents.ensureDocument(documentId),
        ensureDraftBranch: (documentId) =>
          deps.branches.ensureCreatedDraftBranch({ documentId, draftId: draft.id }),
        ...(deps.repair ? { repair: deps.repair } : {}),
      });
    },
    async retractCreate({ draft, documentId }) {
      await lockedSource();
      const retracted = await retractCreate(deps.db, {
        draftId: draft.id,
        documentId,
        retractBranch: () =>
          deps.branches.retractCreatedDraftBranch({ documentId, draftId: draft.id }),
      });
      return retracted.retracted ? "retracted" : "stands";
    },
  };
}
