/**
 * Work-draft review (contract §3, §4): the list, the preview from one cut, and every Apply
 * and Discard command through the one pipeline. A writer's command is looked up before
 * anything is resolved, claimed in its effect transaction and answered from its stored
 * result (§4.6); a refusal before any effect looks the id up again before it answers (LA-1).
 */
import type { YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DraftCommandResult, ThreadDraftListItem } from "@meridian/contracts/drafts";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type {
  CollabDrafts,
  CommandOutcome,
  DraftPreviewResult,
  ModelDraftRow,
  ReviewSelectionCommand,
} from "../contracts.js";
import { type BranchReviewService, DraftChangeRefusal } from "./branch-push-contracts.js";
import { BranchCorruptError } from "./branch-resolver.js";
import {
  type CommandLookup,
  type DraftCommandEnvelope,
  DraftCommandExistsError,
  type DraftCommands,
} from "./draft-commands.js";
import type { DraftDiscard } from "./draft-discard.js";
import { DraftApplyPendingError, type DraftPublication } from "./draft-publication.js";
import type { DraftReviewIdentity } from "./draft-review-identity.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";
import type { ReadReviewCut } from "./ports/review-cut.js";
import type { WorkDraftPendingStore } from "./ports/work-draft-pending-store.js";
import { deriveReviewCut, selectReviewCut } from "./review-cut.js";

export type DraftReviewDiagnostics = {
  unattributedHunks(detail: { documentId: string; draftId: string; hunkIds: string[] }): void;
};

export function createWorkDraftReviewService(input: {
  diagnostics: DraftReviewDiagnostics;
  drafts: Pick<Drafts, "activeForWork">;
  reviewItems: DraftReviewItems;
  identity: DraftReviewIdentity;
  publication: DraftPublication;
  discard: DraftDiscard;
  branchReview: BranchReviewService;
  commands: DraftCommands;
  readReviewCut: ReadReviewCut;
  model: YProsemirrorDocumentModel;
  resolveThreadTitles(threadIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
  pending: Pick<WorkDraftPendingStore, "listDraftsChangingDocument">;
}): CollabDrafts {
  async function workItems(
    workId: WorkId,
  ): Promise<{ draftId: DraftId | null; items: DraftReviewItem[] }> {
    const draft = await input.drafts.activeForWork(workId);
    if (!draft) return { draftId: null, items: [] };
    return { draftId: draft.id, items: await input.reviewItems.list(draft.id) };
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
        return { kind: "result", result: found.result };
      case "blocked":
        return { kind: "blocked" };
    }
  }

  /** Command lookup, first: an existing id answers whatever the draft's state is now. */
  async function known(envelope: DraftCommandEnvelope): Promise<CommandOutcome | null> {
    return replay(await input.commands.lookup(envelope));
  }

  /**
   * The command's answer once the call has finished: what it stored if it stored anything
   * (a completed Apply, a withdrawn one, a Discard), else the result this call computed.
   * Every pre-effect refusal comes through here, so an id that committed meanwhile
   * answers its own outcome (LA-1).
   */
  async function answer(
    envelope: DraftCommandEnvelope,
    computed: DraftCommandResult,
  ): Promise<CommandOutcome> {
    return (await known(envelope)) ?? { kind: "result", result: computed };
  }

  /** Runs an effect that may hand its batch to recovery or lose the id to another request. */
  async function effect(
    envelope: DraftCommandEnvelope,
    run: () => Promise<DraftCommandResult>,
  ): Promise<CommandOutcome> {
    try {
      return await answer(envelope, await run());
    } catch (cause) {
      if (cause instanceof DraftApplyPendingError || cause instanceof DraftCommandExistsError) {
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
      if (cause instanceof BranchCorruptError) {
        // The refusal carries the draft so a corrupt item missing from the list can still
        // build its whole-item Discard, the recovery path.
        const resolved = await input.identity.resolveReviewItem(command);
        return resolved
          ? {
              status: "corrupt",
              draftId: resolved.draftId,
              itemKey: command.itemKey,
              branchGeneration: cause.generation ?? 0,
            }
          : { status: "gone", itemKey: command.itemKey };
      }
      throw cause;
    }
    const { preview: derived, diagnostics } = deriveReviewCut(cut, input.model);
    if (diagnostics.length) {
      input.diagnostics.unattributedHunks({
        documentId: cut.item.documentId,
        draftId: cut.item.draftId,
        hunkIds: diagnostics.map((diagnostic) => diagnostic.hunkId),
      });
    }
    const [item] = await input.reviewItems.withLiveTextTokens([cut.item]);
    return { ...derived, item: item ?? cut.item, threadTitles: cut.threadTitles };
  }

  /** A per-change command needs a listed-or-not text item that is not whole-item. */
  async function changeTarget(
    command: { workId: WorkId; itemKey: string },
    envelope: DraftCommandEnvelope,
  ): Promise<{ item: DraftReviewItem } | { refused: CommandOutcome }> {
    const resolved = await input.identity.resolveReviewItem(command);
    const draftId = resolved?.draftId ?? (envelope.draftId as DraftId);
    const refuse = async (status: "gone" | "whole_item") => ({
      refused: await answer(envelope, { status, draftId, itemKey: command.itemKey }),
    });
    if (!resolved?.draftBranchId) return refuse("gone");
    if (resolved.item.wholeItem) return refuse("whole_item");
    return { item: resolved.item };
  }

  /** Refusals a selection raises from inside the lease answer as the command's own body. */
  async function refusal(
    cause: unknown,
    envelope: DraftCommandEnvelope,
    item: DraftReviewItem,
  ): Promise<CommandOutcome> {
    if (!(cause instanceof DraftChangeRefusal)) throw cause;
    return answer(envelope, {
      status: cause.status,
      draftId: item.draftId,
      itemKey: item.itemKey,
    });
  }

  async function applyChanges(command: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: DraftCommandEnvelope;
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
        const result = await input.publication.applyChanges({
          workId: command.workId,
          item,
          userId: command.userId,
          command: { envelope, shape: "changes" },
          ...(command.signal ? { signal: command.signal } : {}),
          select: async (branch, rows) => {
            const cut = await input.readReviewCut({
              workId: command.workId,
              itemKey: command.itemKey,
            });
            const chosen = selectReviewCut(cut, input.model, branch, rows, selection);
            return {
              ...chosen,
              locationToken: cut.item.tokens.locationToken,
              branchGenerationToken: String(cut.branch.generation),
            };
          },
        });
        if (result.status === "command_exists")
          throw new DraftCommandExistsError(envelope.commandId);
        if (result.status === "stale") {
          return { status: "stale", draftId: item.draftId, itemKey: item.itemKey };
        }
        if (result.status === "gone")
          return { status: "gone", draftId: item.draftId, itemKey: item.itemKey };
        // A completed command stored its own body; `answer` reads it back over this one.
        return { status: "gone", draftId: item.draftId, itemKey: item.itemKey };
      });
    } catch (cause) {
      return refusal(cause, envelope, item);
    }
  }

  async function discardChanges(command: {
    workId: WorkId;
    itemKey: string;
    userId: UserId;
    envelope: DraftCommandEnvelope;
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
        const discarded = await input.branchReview.discardSelected({
          branchId: item.draftBranchId as string,
          reviewedByUserId: command.userId,
          selectRows: async (branch, rows) => {
            const cut = await input.readReviewCut({
              workId: command.workId,
              itemKey: command.itemKey,
            });
            return selectReviewCut(cut, input.model, branch, rows, selection);
          },
          command: {
            envelope,
            result: (outcome) => ({
              status: "discarded",
              draftId: item.draftId,
              itemKey: item.itemKey,
              ...outcome,
            }),
          },
        });
        return discarded.status === "discarded"
          ? {
              status: "discarded",
              draftId: item.draftId,
              itemKey: item.itemKey,
              itemClosed: discarded.itemClosed,
              ...(discarded.itemDisposition ? { itemDisposition: discarded.itemDisposition } : {}),
            }
          : { status: "gone", draftId: item.draftId, itemKey: item.itemKey };
      });
    } catch (cause) {
      return refusal(cause, envelope, item);
    }
  }

  /** The answer an Apply computes when it stored none: its own wire body (§4.5). */
  function applyBody(
    result: Awaited<ReturnType<DraftPublication["applyItems"]>>,
    item: DraftReviewItem | null,
    draftId: DraftId,
  ): DraftCommandResult {
    if (result.status === "command_exists")
      throw new DraftCommandExistsError(item?.itemKey as never);
    if (!item || result.status !== "completed") return result;
    const [applied] = result.items;
    if (!applied) return { status: "gone", draftId };
    return applied.status === "held"
      ? { status: "held", draftId, itemKey: item.itemKey, reason: applied.reason }
      : { status: "applied", draftId, itemKey: item.itemKey, item: applied };
  }

  return {
    draftReview: {
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
        const { draftId, items } = await workItems(command.workId);
        const rendered = await input.reviewItems.withLiveTextTokens(items);
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(rendered.flatMap((item) => item.actorThreadIds)),
        ]);
        return { draftId, items: rendered, threadTitles };
      },
      draftsChangingDocument: (command) => input.pending.listDraftsChangingDocument(command),
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
            await input.publication.applyItems({
              workId: command.workId,
              draftId: item.draftId,
              selection: {
                kind: "rendered",
                items: [{ ...command.tokens, itemKey: item.itemKey }],
              },
              userId: command.userId,
              command: { envelope, shape: "item" },
              ...(command.signal ? { signal: command.signal } : {}),
            }),
            item,
            item.draftId,
          ),
        );
      },
      async applyAll(command) {
        const { envelope, draftId } = command;
        const first = await known(envelope);
        if (first) return first;
        return effect(envelope, async () =>
          applyBody(
            await input.publication.applyItems({
              workId: command.workId,
              draftId,
              selection: { kind: "rendered", items: command.items },
              userId: command.userId,
              command: { envelope, shape: "all" },
              ...(command.signal ? { signal: command.signal } : {}),
            }),
            null,
            draftId,
          ),
        );
      },
      applyChanges,
      async discardItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: DraftCommandResult = {
          status: "discarded",
          draftId: item.draftId,
          itemKey: item.itemKey,
          itemClosed: true,
          itemDisposition: "discarded",
        };
        return effect(envelope, async () => {
          const result = await input.discard.discardItems({
            workId: command.workId,
            draftId: item.draftId,
            selection: {
              kind: "items",
              items: [
                {
                  documentId: item.documentId,
                  draftBranchId: item.draftBranchId,
                  origin: item.origin,
                },
              ],
            },
            userId: command.userId,
            command: { envelope, result: settled },
          });
          return result.status === "gone"
            ? { status: "gone", draftId: item.draftId, itemKey: item.itemKey }
            : settled;
        });
      },
      discardChanges,
      async discardAll(command) {
        const { envelope, draftId } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: DraftCommandResult = { status: "discarded", draftId };
        return effect(envelope, async () => {
          const result = await input.discard.discardItems({
            workId: command.workId,
            draftId,
            selection: { kind: "whole" },
            userId: command.userId,
            command: { envelope, result: settled },
          });
          return result.status === "gone" ? { status: "gone", draftId } : settled;
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
