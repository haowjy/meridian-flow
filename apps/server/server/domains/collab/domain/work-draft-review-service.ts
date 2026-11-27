import type { DraftId } from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DraftItem, TreeSaw } from "@meridian/contracts/drafts";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabDrafts, ModelDraftRow } from "../contracts.js";
import type { DocumentCommands } from "./document-commands.js";
import type { DraftReviewIdentity } from "./draft-review-identity.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { WorkDraftPendingStore } from "./ports/work-draft-pending-store.js";

export function createWorkDraftReviewService(input: {
  reviewItems: DraftReviewItems;
  identity: DraftReviewIdentity;
  commands: DocumentCommands;
  purgeDiscards: CollabDrafts["draftReview"]["purgeDiscards"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  folderIds(draftId: DraftId): Promise<{ id: string }[]>;
  /** The cut the draft's rows are read at: call it before reading them. */
  treeCut(draftId: DraftId): Promise<TreeSaw>;
  pending: Pick<WorkDraftPendingStore, "listDraftsChangingDocument" | "countPendingInProject">;
}): Pick<CollabDrafts, "draftReview"> {
  async function draftItems(
    draft: DraftId,
  ): Promise<{ draftId: DraftId; items: DraftReviewItem[] }> {
    return { draftId: draft, items: await input.reviewItems.list(draft) };
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
        const draftId = command.draft;
        // The vector first: rows read after it are at least as new, so a press never lands what
        // its rows didn't show.
        const saw = await input.treeCut(draftId);
        const items = await input.reviewItems.list(draftId);
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(items.flatMap((item) => item.actorThreadIds)),
        ]);
        const folders = await input.folderIds(draftId);
        return { items, folders, threadTitles, saw };
      },
      pendingDocumentCount: (projectId) => input.pending.countPendingInProject(projectId),
      draftsChangingDocument: (command) => input.pending.listDraftsChangingDocument(command),
      items: (command) => draftItems(command.draft),
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemInDraft: (command) => input.identity.resolveReviewItemInDraft(command),
      lookupCommand: (envelope) => input.commands.lookup(envelope),
      awaitCommand: (envelope) => input.commands.await(envelope),
    },
  };
}

export function reviewContextLocation(uri: string | null): DraftItem["contextLocation"] {
  if (!uri) return null;
  const parsed = parseUnifiedContextUri(uri);
  return parsed.ok && isProjectContextTreeScheme(parsed.value.scheme)
    ? { scheme: parsed.value.scheme, path: `/${parsed.value.path}` }
    : null;
}
