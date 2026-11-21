/** A Work's review list, its counts and the commands it is read under. */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type { ThreadDraftListItem, TreeSaw } from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabBranches, ModelDraftRow } from "../contracts.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";
import type { DocumentCommands } from "./document-commands.js";
import type { WorkBranchPendingStore } from "./ports/work-branch-pending-store.js";

export function createWorkBranchReviewService(input: {
  branches: Pick<Branches, "activeForOwner" | "ownerOf">;
  reviewItems: BranchReviewItems;
  identity: BranchReviewIdentity;
  commands: DocumentCommands;
  purgeDiscards: CollabBranches["draftReview"]["purgeDiscards"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  folderIds(branchId: BranchId): Promise<{ id: string }[]>;
  /** The cut the branch's rows are read at: call it before reading them. */
  treeCut(branchId: BranchId): Promise<TreeSaw>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument" | "countPendingInProject">;
}): Pick<CollabBranches, "draftReview"> {
  async function ownerItems(
    owner: DraftOwner,
  ): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }> {
    const branch = await input.branches.activeForOwner(owner);
    if (!branch) return { branchId: null, items: [] };
    return { branchId: branch.id, items: await input.reviewItems.list(branch.id) };
  }

  return {
    draftReview: {
      purgeDiscards: input.purgeDiscards,
      async list(command) {
        const { items } = await ownerItems(command.owner);
        return items.map(
          (item): ModelDraftRow => ({
            documentId: item.documentId,
            documentName: item.documentName,
            contextLocation: reviewContextLocation(item.path),
            ...(item.isNew ? { createdDocument: true } : {}),
          }),
        );
      },
      async listItems(command) {
        const branch = await input.branches.activeForOwner(command.owner);
        if (!branch)
          return { branchId: null, items: [], folders: [], threadTitles: new Map(), saw: {} };
        const branchId = branch.id;
        // The vector first: rows read after it are at least as new, so a press never lands what
        // its rows didn't show.
        const saw = await input.treeCut(branchId);
        const items = await input.reviewItems.list(branchId);
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(items.flatMap((item) => item.actorThreadIds)),
        ]);
        const folders = await input.folderIds(branchId);
        return { branchId, items, folders, threadTitles, saw };
      },
      pendingDocumentCount: (projectId) => input.pending.countPendingInProject(projectId),
      branchesChangingDocument: (command) => input.pending.listBranchesChangingDocument(command),
      items: (command) => ownerItems(command.owner),
      branchOwner: (branchId) => input.branches.ownerOf(branchId),
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemInBranch: (command) => input.identity.resolveReviewItemInBranch(command),
      resolveItemByDocument: (command) => input.identity.resolveReviewItemByDocument(command),
      lookupCommand: (envelope) => input.commands.lookup(envelope),
      awaitCommand: (envelope) => input.commands.await(envelope),
    },
  };
}

export function reviewContextLocation(uri: string | null): ThreadDraftListItem["contextLocation"] {
  if (!uri) return null;
  const parsed = parseUnifiedContextUri(uri);
  return parsed.ok && isProjectContextTreeScheme(parsed.value.scheme)
    ? { scheme: parsed.value.scheme, path: `/${parsed.value.path}` }
    : null;
}
