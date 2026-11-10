/** Work draft listing, idempotent item and whole Discard, and the frozen Apply command. */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type { BranchCommandResult, ThreadDraftListItem } from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabBranches, CommandOutcome, ModelDraftRow } from "../contracts.js";

import {
  type BranchCommandEnvelope,
  BranchCommandExistsError,
  type BranchCommands,
  type CommandLookup,
} from "./branch-commands.js";
import {
  type BranchDiscard,
  BranchDiscardApplicableStateChangedError,
  BranchDiscardDraftChangedError,
  type DiscardResult,
} from "./branch-discard.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";
import type { WorkBranchPendingStore } from "./ports/work-branch-pending-store.js";

export function createWorkBranchReviewService(input: {
  branches: Pick<Branches, "activeForOwner" | "ownerOf">;
  reviewItems: BranchReviewItems;
  identity: BranchReviewIdentity;
  discard: BranchDiscard;
  commands: BranchCommands;
  applyClick: CollabBranches["draftReview"]["applyClick"];
  unapplyClick: CollabBranches["draftReview"]["unapplyClick"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument" | "countPendingInProject">;
}): CollabBranches {
  async function ownerItems(
    owner: DraftOwner,
  ): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }> {
    const branch = await input.branches.activeForOwner(owner);
    if (!branch) return { branchId: null, items: [] };
    return { branchId: branch.id, items: await input.reviewItems.list(branch.id) };
  }

  function replay(found: CommandLookup): CommandOutcome | null {
    switch (found.kind) {
      case "none":
        return null;
      case "conflict":
        return { kind: "conflict" };
      case "pending":
        return { kind: "pending" };
      case "done":
        return found.commandKind === "apply_click"
          ? { kind: "conflict" }
          : { kind: "result", result: found.result as BranchCommandResult };
    }
  }

  async function known(envelope: BranchCommandEnvelope): Promise<CommandOutcome | null> {
    return replay(await input.commands.lookup(envelope));
  }

  /**
   * The command's answer once the call has finished: what it stored if it stored anything
   * (a completed Apply, a withdrawn one, a Discard), else the result this call computed.
   * Every pre-effect refusal comes through here, so an id that committed meanwhile
   * answers its own outcome (LA-1).
   */
  async function answer(
    envelope: BranchCommandEnvelope,
    computed: BranchCommandResult,
  ): Promise<CommandOutcome> {
    return (await known(envelope)) ?? { kind: "result", result: computed };
  }

  /** Runs an effect that may hand its batch to recovery or lose the id to another request. */
  async function effect(
    envelope: BranchCommandEnvelope,
    run: () => Promise<BranchCommandResult>,
  ): Promise<CommandOutcome> {
    try {
      return await answer(envelope, await run());
    } catch (cause) {
      if (cause instanceof BranchCommandExistsError) {
        return (await known(envelope)) ?? { kind: "pending" };
      }
      throw cause;
    }
  }

  return {
    draftReview: {
      applyClick: input.applyClick,
      unapplyClick: input.unapplyClick,
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
        return { branchId, items, threadTitles };
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
        const refused = (status: "stale" | "gone" | "draft_changed"): BranchCommandResult => ({
          status,
          branchId: item.branchId,
          itemKey: item.itemKey,
        });
        // What the kernel ended decides the answer, stored with the command in its transaction.
        const settled = (ended: DiscardResult): BranchCommandResult => {
          if (ended.status === "gone") return refused("gone");
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
          try {
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
          } catch (cause) {
            if (cause instanceof BranchDiscardApplicableStateChangedError) return refused("stale");
            if (cause instanceof BranchDiscardDraftChangedError) return refused("draft_changed");
            throw cause;
          }
        });
      },
      async discardAll(command) {
        const { envelope, branchId } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled = (ended: DiscardResult): BranchCommandResult =>
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
