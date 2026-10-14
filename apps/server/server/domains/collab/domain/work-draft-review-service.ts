/**
 * Work-draft review (contract §1, §3, §4): the list, an item's metadata, and every Apply and
 * item Discard command through the one pipeline. A writer's command is looked up before anything
 * is resolved, claimed in its effect transaction and answered from its stored result (§1.4); a
 * refusal before any effect looks the id up again before it answers (LA-1). The review itself
 * lives in the browser: the draft room projects `prosemirror` against its `review_base`.
 */
import type { DraftId, WorkId } from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type {
  DraftAttribution,
  DraftCommandOutcome,
  DraftItemMeta,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import { branchRoomName, isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CollabDrafts, CommandOutcome, ModelDraftRow } from "../contracts.js";
import type { DraftAttributionService } from "./draft-attribution.js";
import {
  type CommandLookup,
  type DraftCommandEnvelope,
  DraftCommandExistsError,
  type DraftCommands,
} from "./draft-commands.js";
import type { DraftDiscard } from "./draft-discard.js";
import {
  type ApplyItemRef,
  DraftApplyPendingError,
  type DraftPublication,
} from "./draft-publication.js";
import type { DraftReviewIdentity } from "./draft-review-identity.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";
import type { WorkDraftPendingStore } from "./ports/work-draft-pending-store.js";

export function createWorkDraftReviewService(input: {
  drafts: Pick<Drafts, "activeForWork">;
  reviewItems: DraftReviewItems;
  identity: DraftReviewIdentity;
  publication: DraftPublication;
  discard: DraftDiscard;
  commands: DraftCommands;
  attribution: DraftAttributionService;
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
    computed: DraftCommandOutcome,
  ): Promise<CommandOutcome> {
    return (await known(envelope)) ?? { kind: "result", result: computed };
  }

  /** Runs an effect that may hand its batch to recovery or lose the id to another request. */
  async function effect(
    envelope: DraftCommandEnvelope,
    run: () => Promise<DraftCommandOutcome>,
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

  /** An item's existence and where to open it (§3.2): any addressable item, listed or not. */
  async function itemMeta(command: {
    workId: WorkId;
    itemKey: string;
  }): Promise<DraftItemMeta | { status: "gone"; itemKey: string }> {
    const resolved = await input.identity.resolveReviewItem(command);
    if (!resolved) return { status: "gone", itemKey: command.itemKey };
    const { item } = resolved;
    const base = {
      draftId: item.draftId,
      itemKey: item.itemKey,
      documentId: item.documentId,
      isNew: item.isNew,
    };
    return item.draftBranchId
      ? {
          kind: "text",
          ...base,
          roomName: branchRoomName(item.draftBranchId),
          wholeItem: item.wholeItem,
          hasChanges: item.hasChanges,
        }
      : { kind: "branchless", ...base, wholeItem: true, hasChanges: false };
  }

  /**
   * Runs an Apply and answers from the row it stored: the tree step stores a completed or
   * withdrawn batch's result, the publication stores a refusal decided before staging.
   */
  async function apply(
    envelope: DraftCommandEnvelope,
    run: () => ReturnType<DraftPublication["applyItems"]>,
  ): Promise<CommandOutcome> {
    const first = await known(envelope);
    if (first) return first;
    try {
      await run();
      // The row holds the answer; a lost race on the id answers the winner's row. A command
      // whose row is still pending (a staged batch) is the handoff: the client observes it.
      return (await known(envelope)) ?? { kind: "pending" };
    } catch (cause) {
      if (cause instanceof DraftApplyPendingError || cause instanceof DraftCommandExistsError) {
        return (await known(envelope)) ?? { kind: "pending" };
      }
      throw cause;
    }
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
        const threadTitles = await input.resolveThreadTitles([
          ...new Set(items.flatMap((item) => item.actorThreadIds)),
        ]);
        return { draftId, items, threadTitles };
      },
      draftsChangingDocument: (command) => input.pending.listDraftsChangingDocument(command),
      items: (command) => workItems(command.workId),
      async addressableItems(command) {
        const draft = await input.drafts.activeForWork(command.workId);
        if (!draft) return { draftId: null, items: [] };
        return { draftId: draft.id, items: await input.reviewItems.addressable(draft.id) };
      },
      resolveItem: (command) => input.identity.resolveReviewItem(command),
      resolveItemByDocument: (command) => input.identity.resolveReviewItemByDocument(command),
      itemMeta,
      async attribution(command): Promise<DraftAttribution | null> {
        const resolved = await input.identity.resolveReviewItem(command);
        return resolved ? input.attribution.forItem(resolved.item) : null;
      },
      lookupCommand: (envelope) => input.commands.lookup(envelope),
      applyItem(command) {
        const { envelope, item } = command;
        return apply(envelope, () =>
          input.publication.applyItems({
            workId: command.workId,
            draftId: item.draftId,
            items: [
              {
                itemKey: item.itemKey,
                ...(command.locationToken ? { locationToken: command.locationToken } : {}),
                ...(command.snapshot
                  ? { content: { scope: "item", snapshot: command.snapshot } }
                  : {}),
              },
            ],
            userId: command.userId,
            command: { envelope, shape: "item" },
            ...(command.signal ? { signal: command.signal } : {}),
          }),
        );
      },
      applyAll(command) {
        const { envelope, draftId } = command;
        return apply(envelope, () =>
          input.publication.applyItems({
            workId: command.workId,
            draftId,
            items: command.items.map(
              (ref): ApplyItemRef => ({
                itemKey: ref.itemKey,
                locationToken: ref.locationToken,
                ...(ref.snapshot ? { content: { scope: "item", snapshot: ref.snapshot } } : {}),
              }),
            ),
            userId: command.userId,
            command: { envelope, shape: "all" },
            ...(command.signal ? { signal: command.signal } : {}),
          }),
        );
      },
      applyChanges(command) {
        const { envelope, item } = command;
        return apply(envelope, () =>
          input.publication.applyItems({
            workId: command.workId,
            draftId: item.draftId,
            items: [
              {
                itemKey: item.itemKey,
                ...(command.locationToken ? { locationToken: command.locationToken } : {}),
                content: {
                  scope: "changes",
                  changeIds: [...command.changeIds],
                  snapshot: command.snapshot,
                },
              },
            ],
            userId: command.userId,
            command: { envelope, shape: "changes" },
            ...(command.signal ? { signal: command.signal } : {}),
          }),
        );
      },
      async discardItem(command) {
        const { envelope, item } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: DraftCommandOutcome = {
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
      async discardAll(command) {
        const { envelope, draftId } = command;
        const first = await known(envelope);
        if (first) return first;
        const settled: DraftCommandOutcome = { status: "discarded", draftId };
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
