/** A draft's review list, its counts and the commands it is read under. */
import type { DraftId } from "@meridian/contracts";
import type { ThreadDraftListItem, TreeSaw } from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabBranches, ModelDraftRow } from "../contracts.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { DocumentCommands } from "./document-commands.js";
import type { WorkBranchPendingStore } from "./ports/work-branch-pending-store.js";

export function createWorkBranchReviewService(input: {
  reviewItems: BranchReviewItems;
  identity: BranchReviewIdentity;
  commands: DocumentCommands;
  purgeDiscards: CollabBranches["draftReview"]["purgeDiscards"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  folderIds(branchId: DraftId): Promise<{ id: string }[]>;
  /** The cut the branch's rows are read at: call it before reading them. */
  treeCut(branchId: DraftId): Promise<TreeSaw>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument" | "countPendingInProject">;
}): Pick<CollabBranches, "draftReview"> {
  async function draftItems(
    draft: DraftId,
  ): Promise<{ branchId: DraftId; items: DraftReviewItem[] }> {
    return { branchId: draft, items: await input.reviewItems.list(draft) };
  }

  return {
    draftReview: {
      purgeDiscards: input.purgeDiscards,
      async list(command) {
        const { items } = await draftItems(command.draft);
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
        const branchId = command.draft;
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
      items: (command) => draftItems(command.draft),
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemInBranch: (command) => input.identity.resolveReviewItemInBranch(command),
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
