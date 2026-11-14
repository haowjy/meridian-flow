/** Work draft listing, idempotent item and whole Discard, and the frozen Apply command. */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type { DiscardCommandResult, ThreadDraftListItem } from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabBranches, CommandOutcome, ModelDraftRow } from "../contracts.js";
import type { BranchDiscard, DiscardResult } from "./branch-discard.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";
import {
  type DocumentCommandEnvelope,
  DocumentCommandExistsError,
  type DocumentCommands,
  replay,
} from "./document-commands.js";
import type { WorkBranchPendingStore } from "./ports/work-branch-pending-store.js";

export function createWorkBranchReviewService(input: {
  branches: Pick<Branches, "activeForOwner" | "ownerOf">;
  reviewItems: BranchReviewItems;
  identity: BranchReviewIdentity;
  discard: BranchDiscard;
  commands: DocumentCommands;
  apply: CollabBranches["draftReview"]["apply"];
  unapplyClick: CollabBranches["draftReview"]["unapplyClick"];
  undoDiscard: CollabBranches["draftReview"]["undoDiscard"];
  commandDocuments: CollabBranches["draftReview"]["commandDocuments"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  folderRevisions(branchId: BranchId): Promise<{ id: string; revision: string }[]>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument" | "countPendingInProject">;
}): CollabBranches {
  async function ownerItems(
    owner: DraftOwner,
  ): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }> {
    const branch = await input.branches.activeForOwner(owner);
    if (!branch) return { branchId: null, items: [] };
    return { branchId: branch.id, items: await input.reviewItems.list(branch.id) };
  }

  async function known(envelope: DocumentCommandEnvelope): Promise<CommandOutcome | null> {
    const stored = replay<DiscardCommandResult>(
      await input.commands.lookup(envelope),
      envelope.commandId,
    );
    if (!stored) return null;
    return stored.status === "conflict" ? { kind: "conflict" } : { kind: "result", result: stored };
  }

  /**
   * The command's answer once the call has finished: what it stored if it stored anything
   * (a Discard, or its stored refusal), else the result this call computed. Every pre-effect
   * refusal comes through here, so an id that committed meanwhile answers its own outcome.
   */
  async function answer(
    envelope: DocumentCommandEnvelope,
    computed: DiscardCommandResult,
  ): Promise<CommandOutcome> {
    return (await known(envelope)) ?? { kind: "result", result: computed };
  }

  /** Runs an effect that may lose the id to another request. */
  async function effect(
    envelope: DocumentCommandEnvelope,
    run: () => Promise<DiscardCommandResult>,
  ): Promise<CommandOutcome> {
    try {
      return await answer(envelope, await run());
    } catch (cause) {
      if (cause instanceof DocumentCommandExistsError) {
        const winner = await known(envelope);
        if (winner) return winner;
      }
      throw cause;
    }
  }

  return {
    draftReview: {
      apply: input.apply,
      unapplyClick: input.unapplyClick,
      undoDiscard: input.undoDiscard,
      commandDocuments: input.commandDocuments,
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
        const { branchId, items } = await ownerItems(command.owner);
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(items.flatMap((item) => item.actorThreadIds)),
        ]);
        const folders = branchId ? await input.folderRevisions(branchId) : [];
        return { branchId, items, folders, threadTitles };
      },
      pendingDocumentCount: (projectId) => input.pending.countPendingInProject(projectId),
      branchesChangingDocument: (command) => input.pending.listBranchesChangingDocument(command),
      items: (command) => ownerItems(command.owner),
      branchOwner: (branchId) => input.branches.ownerOf(branchId),
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemInBranch: (command) => input.identity.resolveReviewItemInBranch(command),
      resolveItemByDocument: (command) => input.identity.resolveReviewItemByDocument(command),
      lookupCommand: (envelope) => input.commands.lookup(envelope),
      async discardItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        const refused = (status: "stale" | "gone" | "draft_changed"): DiscardCommandResult => ({
          status,
          branchId: item.branchId,
          itemKey: item.itemKey,
        });
        // What the kernel ended decides the answer, stored with the command in its transaction.
        const settled = (ended: DiscardResult): DiscardCommandResult => {
          if (ended.status === "gone") return refused("gone");
          if (ended.status === "refused") return refused(ended.reason);
          const closed = ended.branchClosed || ended.closed.includes(item.documentId);
          return {
            status: "discarded",
            branchId: item.branchId,
            itemKey: item.itemKey,
            ...(closed
              ? { itemClosed: true, itemDisposition: "discarded" as const }
              : { itemClosed: false }),
          };
        };
        return effect(envelope, async () => {
          return settled(
            await input.discard.discardItems({
              branchId: item.branchId,
              selection: {
                kind: "items",
                items: [
                  {
                    documentId: item.documentId,
                    origin: item.origin,
                    ends: command.ends,
                    ...(command.draftSeenAt !== undefined
                      ? { draftSeenAt: command.draftSeenAt }
                      : {}),
                  },
                ],
              },
              userId: command.userId,
              command: { envelope, result: settled },
            }),
          );
        });
      },
      async discardAll(command) {
        const { envelope, branchId } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled = (ended: DiscardResult): DiscardCommandResult =>
          ended.status === "gone"
            ? { status: "gone", branchId }
            : { status: "discarded", branchId };
        return effect(envelope, async () =>
          settled(
            await input.discard.discardItems({
              branchId,
              selection: { kind: "whole" },
              userId: command.userId,
              command: { envelope, result: settled },
            }),
          ),
        );
      },
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
