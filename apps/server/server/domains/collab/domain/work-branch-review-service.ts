/** Work draft listing, idempotent item and whole Discard, and the frozen Apply command. */
import type { BranchId, DraftOwner } from "@meridian/contracts";
import type {
  DiscardCommandResult,
  ThreadDraftListItem,
  TreeSaw,
} from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import {
  type CommandEnvelope,
  CommandExistsError,
  replay,
} from "../../../shared/commands/command-record.js";
import type { CollabBranches, CommandOutcome, ModelDraftRow } from "../contracts.js";
import type { BranchDiscard, DiscardResult } from "./branch-discard.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";
import type { DocumentCommands } from "./document-commands.js";
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
  listDiscards: CollabBranches["draftReview"]["listDiscards"];
  purgeDiscards: CollabBranches["draftReview"]["purgeDiscards"];
  commandDocuments: CollabBranches["draftReview"]["commandDocuments"];
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  folderIds(branchId: BranchId): Promise<{ id: string }[]>;
  /** The cut the branch's rows are read at: call it before reading them. */
  treeCut(branchId: BranchId): Promise<TreeSaw>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument" | "countPendingInProject">;
}): CollabBranches {
  async function ownerItems(
    owner: DraftOwner,
  ): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }> {
    const branch = await input.branches.activeForOwner(owner);
    if (!branch) return { branchId: null, items: [] };
    return { branchId: branch.id, items: await input.reviewItems.list(branch.id) };
  }

  async function known(envelope: CommandEnvelope): Promise<CommandOutcome | null> {
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
    envelope: CommandEnvelope,
    computed: DiscardCommandResult,
  ): Promise<CommandOutcome> {
    return (await known(envelope)) ?? { kind: "result", result: computed };
  }

  /** Runs an effect that may lose the id to another request. */
  async function effect(
    envelope: CommandEnvelope,
    run: () => Promise<DiscardCommandResult>,
  ): Promise<CommandOutcome> {
    try {
      return await answer(envelope, await run());
    } catch (cause) {
      if (cause instanceof CommandExistsError) {
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
      listDiscards: input.listDiscards,
      purgeDiscards: input.purgeDiscards,
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
      async discardItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        // What the kernel ended decides the answer, stored with the command in its transaction.
        const settled = (ended: DiscardResult): DiscardCommandResult => {
          const closed = ended.branchClosed || ended.closed.includes(item.documentId);
          const overtaken = ended.settled.some(
            (one) => one.rule === "overtaken" && one.state === "applied",
          );
          return {
            status: "discarded",
            branchId: item.branchId,
            itemKey: item.itemKey,
            ...(closed
              ? { itemClosed: true, itemDisposition: overtaken ? "applied" : "discarded" }
              : { itemClosed: false }),
            ...notesOf(ended),
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
                  },
                ],
              },
              userId: command.userId,
              command: { envelope, result: settled },
            }),
          );
        });
      },
      async discardBranch(command) {
        const { envelope, branchId, selection } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled = (ended: DiscardResult): DiscardCommandResult => ({
          status: "discarded",
          branchId,
          ...(ended.branchClosed ? {} : { closed: [...ended.closed] }),
          ...notesOf(ended),
        });
        return effect(envelope, async () =>
          settled(
            await input.discard.discardItems({
              branchId,
              selection,
              userId: command.userId,
              command: { envelope, result: settled },
            }),
          ),
        );
      },
    },
  };
}

const notesOf = (ended: DiscardResult) =>
  ended.settled.length > 0 ? { settled: ended.settled } : {};

export function reviewContextLocation(uri: string | null): ThreadDraftListItem["contextLocation"] {
  if (!uri) return null;
  const parsed = parseUnifiedContextUri(uri);
  return parsed.ok && isProjectContextTreeScheme(parsed.value.scheme)
    ? { scheme: parsed.value.scheme, path: `/${parsed.value.path}` }
    : null;
}
