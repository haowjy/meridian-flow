/**
 * Work-draft review (contract §3, §4): the list, the preview from one cut, and every Apply
 * and Discard command through the one pipeline. A writer's command is looked up before
 * anything is resolved, claimed in its effect transaction and answered from its stored
 * result (§4.6); a refusal before any effect looks the id up again before it answers (LA-1).
 */
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type {
  ApplyClickAnswer,
  BranchCommandResult,
  ThreadDraftListItem,
} from "@meridian/contracts/branches";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import type {
  CollabBranches,
  CommandOutcome,
  DraftPreviewResult,
  ModelDraftRow,
  ReviewSelectionCommand,
} from "../contracts.js";
import { checkApplyClick } from "./apply-click.js";
import { type BranchApply, BranchApplyPendingError } from "./branch-apply.js";
import {
  type BranchCommandEnvelope,
  BranchCommandExistsError,
  type BranchCommands,
  type CommandLookup,
} from "./branch-commands.js";
import type { BranchDiscard } from "./branch-discard.js";
import { DraftChangeRefusal, type DraftReviewService } from "./branch-push-contracts.js";
import type { BranchReviewIdentity } from "./branch-review-identity.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import type { Branches } from "./branches.js";
import { DraftCorruptError } from "./draft-resolver.js";
import type { ReadReviewCut } from "./ports/review-cut.js";
import type { WorkBranchPendingStore } from "./ports/work-branch-pending-store.js";
import { deriveReviewCut, selectReviewCut } from "./review-cut.js";

export type DraftReviewDiagnostics = {
  unattributedHunks(detail: { documentId: string; branchId: string; hunkIds: string[] }): void;
};

export function createWorkBranchReviewService(input: {
  diagnostics: DraftReviewDiagnostics;
  branches: Pick<Branches, "activeForWork">;
  reviewItems: BranchReviewItems;
  identity: BranchReviewIdentity;
  branchApply: BranchApply;
  discard: BranchDiscard;
  draftReview: DraftReviewService;
  commands: BranchCommands;
  readReviewCut: ReadReviewCut;
  model: YProsemirrorDocumentModel;
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  pending: Pick<WorkBranchPendingStore, "listBranchesChangingDocument">;
}): CollabBranches {
  async function applyClick(
    command: Parameters<CollabBranches["draftReview"]["applyClick"]>[0],
  ): Promise<ApplyClickAnswer> {
    const commandId = command.envelope.commandId;
    async function lookup(): Promise<ApplyClickAnswer | null> {
      const found = await input.commands.lookup(command.envelope);
      if (found.kind === "none") return null;
      if (found.kind === "done") {
        if (found.commandKind !== "apply_click") return { status: "conflict", commandId };
        return found.result as ApplyClickAnswer;
      }
      return { status: found.kind === "conflict" ? "conflict" : "pending", commandId };
    }
    const recorded = await lookup();
    if (recorded) return recorded;
    const refuse = async (
      reason: import("@meridian/contracts/branches").ApplyClickRefusalReason,
    ): Promise<ApplyClickAnswer> => (await lookup()) ?? { status: "refused", commandId, reason };
    const resolved = await input.identity.resolveReviewItemByDocument(command);
    if (!resolved?.draftId) return (await lookup()) ?? { status: "closed", commandId };
    let cut: Awaited<ReturnType<ReadReviewCut>>;
    try {
      cut = await input.readReviewCut({ workId: command.workId, itemKey: resolved.itemKey });
    } catch (cause) {
      if (cause instanceof DraftChangeRefusal && cause.status === "gone")
        return (await lookup()) ?? { status: "closed", commandId };
      if (cause instanceof DraftCorruptError) return refuse("unavailable");
      throw cause;
    }
    const room = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(room, cut.documentDraft.state);
      const reason = checkApplyClick(room, command.request, input.model.schema);
      return refuse(reason ?? "unavailable");
    } finally {
      room.destroy();
    }
  }

  async function workItems(
    workId: WorkId,
  ): Promise<{ branchId: BranchId | null; items: DraftReviewItem[] }> {
    const branch = await input.branches.activeForWork(workId);
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
      case "blocked":
        return { kind: "blocked" };
    }
  }

  /** Command lookup, first: an existing id answers whatever the branch's state is now. */
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
      if (cause instanceof BranchApplyPendingError || cause instanceof BranchCommandExistsError) {
        return (await known(envelope)) ?? { kind: "pending" };
      }
      throw cause;
    }
  }

  async function preview(command: {
    workId: WorkId;
    itemKey: string;
  }): Promise<DraftPreviewResult> {
    let cut: Awaited<ReturnType<ReadReviewCut>>;
    try {
      cut = await input.readReviewCut(command);
    } catch (cause) {
      if (cause instanceof DraftChangeRefusal && cause.status === "gone") {
        return { status: "gone", itemKey: command.itemKey };
      }
      if (cause instanceof DraftCorruptError) {
        // The refusal carries the branch ID so a corrupt item missing from the list can still
        // build its whole-item Discard, the recovery path.
        const resolved = await input.identity.resolveReviewItem(command);
        return resolved
          ? {
              status: "corrupt",
              branchId: resolved.branchId,
              itemKey: command.itemKey,
              draftGeneration: cause.generation ?? 0,
            }
          : { status: "gone", itemKey: command.itemKey };
      }
      throw cause;
    }
    const { preview: derived, diagnostics } = deriveReviewCut(cut, input.model);
    if (diagnostics.length) {
      input.diagnostics.unattributedHunks({
        documentId: cut.item.documentId,
        branchId: cut.item.branchId,
        hunkIds: diagnostics.map((diagnostic) => diagnostic.hunkId),
      });
    }
    const [item] = await input.reviewItems.withLiveTextTokens([cut.item]);
    return { ...derived, item: item ?? cut.item, threadTitles: cut.threadTitles };
  }

  /** A per-change command needs a listed-or-not text item that is not whole-item. */
  async function changeTarget(
    command: { workId: WorkId; itemKey: string },
    envelope: BranchCommandEnvelope,
  ): Promise<{ item: DraftReviewItem } | { refused: CommandOutcome }> {
    const resolved = await input.identity.resolveReviewItem(command);
    const branchId = resolved?.branchId ?? (envelope.branchId as BranchId);
    const refuse = async (status: "gone" | "whole_item") => ({
      refused: await answer(envelope, { status, branchId, itemKey: command.itemKey }),
    });
    if (!resolved?.draftId) return refuse("gone");
    if (resolved.item.wholeItem) return refuse("whole_item");
    return { item: resolved.item };
  }

  /** Refusals a selection raises inside its commit scope answer as the command's own body. */
  async function refusal(
    cause: unknown,
    envelope: BranchCommandEnvelope,
    item: DraftReviewItem,
  ): Promise<CommandOutcome> {
    if (!(cause instanceof DraftChangeRefusal)) throw cause;
    return answer(envelope, {
      status: cause.status,
      branchId: item.branchId,
      itemKey: item.itemKey,
    });
  }

  async function applyChanges(command: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: BranchCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "apply" }>;
    signal?: AbortSignal;
  }): Promise<CommandOutcome> {
    const { envelope, selection } = command;
    const first = await known(envelope);
    if (first) return first;
    const target = await changeTarget(command, envelope);
    if ("refused" in target) return target.refused;
    const { item } = target;
    try {
      return await effect(envelope, async () => {
        const result = await input.branchApply.applyChanges({
          workId: command.workId,
          item,
          userId: command.userId,
          command: { envelope, shape: "changes" },
          ...(command.signal ? { signal: command.signal } : {}),
          select: async (documentDraft, rows) => {
            const cut = await input.readReviewCut({
              workId: command.workId,
              itemKey: command.itemKey,
            });
            const chosen = selectReviewCut(cut, input.model, documentDraft, rows, selection);
            return {
              ...chosen,
              locationToken: cut.item.tokens.locationToken,
              draftGenerationToken: String(cut.documentDraft.generation),
            };
          },
        });
        if (result.status === "command_exists")
          throw new BranchCommandExistsError(envelope.commandId);
        if (result.status === "stale") {
          return { status: "stale", branchId: item.branchId, itemKey: item.itemKey };
        }
        if (result.status === "gone")
          return { status: "gone", branchId: item.branchId, itemKey: item.itemKey };
        // A completed command stored its own body; `answer` reads it back over this one.
        return { status: "gone", branchId: item.branchId, itemKey: item.itemKey };
      });
    } catch (cause) {
      return refusal(cause, envelope, item);
    }
  }

  async function discardChanges(command: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: BranchCommandEnvelope;
    selection: Extract<ReviewSelectionCommand, { kind: "discard" }>;
  }): Promise<CommandOutcome> {
    const { envelope, selection } = command;
    const first = await known(envelope);
    if (first) return first;
    const target = await changeTarget(command, envelope);
    if ("refused" in target) return target.refused;
    const { item } = target;
    try {
      return await effect(envelope, async () => {
        const discarded = await input.draftReview.discardSelected({
          draftId: item.draftId as string,
          reviewedByUserId: command.userId,
          selectRows: async (documentDraft, rows) => {
            const cut = await input.readReviewCut({
              workId: command.workId,
              itemKey: command.itemKey,
            });
            return selectReviewCut(cut, input.model, documentDraft, rows, selection);
          },
          command: {
            envelope,
            result: (outcome) => ({
              status: "discarded",
              branchId: item.branchId,
              itemKey: item.itemKey,
              ...outcome,
            }),
          },
        });
        return discarded.status === "discarded"
          ? {
              status: "discarded",
              branchId: item.branchId,
              itemKey: item.itemKey,
              itemClosed: discarded.itemClosed,
              ...(discarded.itemDisposition ? { itemDisposition: discarded.itemDisposition } : {}),
            }
          : { status: "gone", branchId: item.branchId, itemKey: item.itemKey };
      });
    } catch (cause) {
      return refusal(cause, envelope, item);
    }
  }

  /** The answer an Apply computes when it stored none: its own wire body (§4.5). */
  function applyBody(
    result: Awaited<ReturnType<BranchApply["applyItems"]>>,
    item: DraftReviewItem | null,
    branchId: BranchId,
  ): BranchCommandResult {
    if (result.status === "command_exists")
      throw new BranchCommandExistsError(item?.itemKey as never);
    // An item Apply answers about its own item (§4.5); the batch's key list is not its wire shape.
    if (item && result.status === "stale")
      return { status: "stale", branchId, itemKey: item.itemKey };
    if (!item || result.status !== "completed") return result;
    const [applied] = result.items;
    if (!applied) return { status: "gone", branchId };
    return applied.status === "held"
      ? { status: "held", branchId, itemKey: item.itemKey, reason: applied.reason }
      : { status: "applied", branchId, itemKey: item.itemKey, item: applied };
  }

  return {
    draftReview: {
      applyClick,
      async list(command) {
        const { items } = await workItems(command.workId);
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
        const { branchId, items } = await workItems(command.workId);
        const rendered = await input.reviewItems.withLiveTextTokens(items);
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(rendered.flatMap((item) => item.actorThreadIds)),
        ]);
        return { branchId, items: rendered, threadTitles };
      },
      branchesChangingDocument: (command) => input.pending.listBranchesChangingDocument(command),
      items: (command) => workItems(command.workId),
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemByDocument: (command) => input.identity.resolveReviewItemByDocument(command),
      preview,
      lookupCommand: (envelope) => input.commands.lookup(envelope),
      async applyItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        return effect(envelope, async () =>
          applyBody(
            await input.branchApply.applyItems({
              workId: command.workId,
              branchId: item.branchId,
              selection: {
                kind: "rendered",
                items: [{ ...command.tokens, itemKey: item.itemKey }],
              },
              userId: command.userId,
              command: { envelope, shape: "item" },
              ...(command.signal ? { signal: command.signal } : {}),
            }),
            item,
            item.branchId,
          ),
        );
      },
      async applyAll(command) {
        const { envelope, branchId } = command;
        const first = await known(envelope);
        if (first) return first;
        return effect(envelope, async () =>
          applyBody(
            await input.branchApply.applyItems({
              workId: command.workId,
              branchId,
              selection: { kind: "rendered", items: command.items },
              userId: command.userId,
              command: { envelope, shape: "all" },
              ...(command.signal ? { signal: command.signal } : {}),
            }),
            null,
            branchId,
          ),
        );
      },
      applyChanges,
      async discardItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: BranchCommandResult = {
          status: "discarded",
          branchId: item.branchId,
          itemKey: item.itemKey,
          itemClosed: true,
          itemDisposition: "discarded",
        };
        return effect(envelope, async () => {
          const result = await input.discard.discardItems({
            workId: command.workId,
            branchId: item.branchId,
            selection: {
              kind: "items",
              items: [
                {
                  documentId: item.documentId,
                  draftId: item.draftId,
                  origin: item.origin,
                },
              ],
            },
            userId: command.userId,
            command: { envelope, result: settled },
          });
          return result.status === "gone"
            ? { status: "gone", branchId: item.branchId, itemKey: item.itemKey }
            : settled;
        });
      },
      discardChanges,
      async discardAll(command) {
        const { envelope, branchId } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: BranchCommandResult = { status: "discarded", branchId };
        return effect(envelope, async () => {
          const result = await input.discard.discardItems({
            workId: command.workId,
            branchId,
            selection: { kind: "whole" },
            userId: command.userId,
            command: { envelope, result: settled },
          });
          return result.status === "gone" ? { status: "gone", branchId } : settled;
        });
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
