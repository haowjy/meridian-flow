/**
 * Postgres branch creates for one source: the tree owner's hidden-node lifecycle with the
 * collab half injected (the branch's document draft is ensured and retracted by collab, which owns
 * draft lifecycle, journals and pooled cores).
 */
import type { Database } from "@meridian/database";
import type { DraftPeerShadowAccess, MarkdownDocumentStore } from "../../../collab/index.js";
import type { BranchCreatePort } from "../../ports/branch-create.js";
import type { DocumentRemoval } from "../../ports/document-removal.js";
import { createInBranch } from "../../tree/creates.js";
import { retractCreate } from "../../tree/end-use.js";
import type { HiddenNodeRepair } from "../../tree/hidden-node-repair.js";
import { lockDocumentNamespaces } from "./document-locations.js";

export function createDrizzleBranchCreates(deps: {
  db: Database;
  removal: DocumentRemoval;
  /** The source, provisioned when the first create needs it. */
  sourceId(): Promise<string>;
  documents: Pick<MarkdownDocumentStore, "initializeEmptyDocument" | "repairDocumentAuthority">;
  drafts: Pick<DraftPeerShadowAccess, "ensureCreatedDocumentDraft" | "retractCreatedDocumentDraft">;
  /** Repair on touch: the candidate picker reports what it repaired (§12.4). */
  repair?: Pick<HiddenNodeRepair, "report" | "tombstoneUnused">;
}): BranchCreatePort {
  /**
   * The source, with its namespace held (§14: after the command's Work and branch, before
   * any document lock). A resolved source id is cached across commands, so the lock is
   * taken here, every command, never left to provisioning.
   */
  async function lockedSource(): Promise<string> {
    const sourceId = await deps.sourceId();
    await lockDocumentNamespaces(deps.db, [], [sourceId]);
    return sourceId;
  }

  return {
    async createInBranch({ branch, dir, name, extension, node, createdBy }) {
      return createInBranch(deps.db, {
        branchId: branch.id,
        contextSourceId: await lockedSource(),
        dir,
        name,
        extension,
        node,
        ...(createdBy ? { createdBy } : {}),
        initializeEmptyContent: (documentId) => deps.documents.initializeEmptyDocument(documentId),
        repairContent: (documentId) => deps.documents.repairDocumentAuthority(documentId),
        ensureDocumentDraft: (documentId) =>
          deps.drafts.ensureCreatedDocumentDraft({ documentId, branchId: branch.id }),
        ...(deps.repair ? { repair: deps.repair } : {}),
      });
    },
    async retractCreate({ branch, documentId, cause }) {
      await lockedSource();
      const retracted = await retractCreate(deps.db, {
        branchId: branch.id,
        documentId,
        cause,
        removal: deps.removal,
        retractDraft: () =>
          deps.drafts.retractCreatedDocumentDraft({ documentId, branchId: branch.id }),
      });
      return retracted.retracted ? "retracted" : "stands";
    },
  };
}
