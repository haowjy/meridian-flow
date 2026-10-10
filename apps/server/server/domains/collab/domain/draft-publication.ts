/**
 * Apply as one publication (contract §11): a draft's selected items become one batch on
 * the settlement seam, carrying the `draft_tree` payload the tree step publishes with the
 * text. `applyItems` registers the link cut (§10.8), stages through `pushBranchesToLive`
 * and maps per-item results; the step itself (tokens, holds, vacate and install, arrivals,
 * holder bindings, history, row drop, close) is `adapters/drizzle-draft-tree-step.ts`.
 * Every Apply caller goes through here: the per-document route, Apply all and D40's switch.
 */
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import type { BranchPushService } from "./branch-push-contracts.js";
import { collabHook } from "./collab-test-hooks.js";
import type {
  DraftBranchAheadRegistration,
  DraftLinkCut,
  DraftLinkRegistrationFailure,
} from "./draft-branch-ahead-registration.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import {
  DRAFT_TREE_STEP,
  type DraftItemKey,
  type DraftTreePayload,
  encodeDraftTreePayload,
  type HeldReason,
  readDraftTreeHold,
  readDraftTreeRefusal,
} from "./draft-tree-payload.js";
import type { Drafts } from "./drafts.js";
import type { PublicationRefusal } from "./ports/settlement-publication.js";

export {
  DRAFT_TREE_STEP,
  type DraftItemKey,
  draftItemKey,
  type HeldReason,
} from "./draft-tree-payload.js";

/**
 * What the writer was shown of one item. Tokens absent: the legacy per-document Apply
 * without them, or D40's confirmed count; nothing is compared then (as before).
 */
export type ApplyItemRef = {
  itemKey: DraftItemKey;
  locationToken?: string;
  liveTextToken?: string;
  branchGenerationToken?: string;
};

export type ApplySelection =
  | { kind: "rendered"; items: readonly ApplyItemRef[] }
  /** D40's switch: the writer confirmed a count; every item pending now. */
  | { kind: "all_pending" };

export type ApplyNote =
  | { code: "rename_replaced"; replacedPath: string; path: string }
  | { code: "restored"; path: string };
export type ApplyItemResult =
  | { itemKey: DraftItemKey; status: "applied"; notes: readonly ApplyNote[] }
  | { itemKey: DraftItemKey; status: "held"; reason: HeldReason };
export type ApplyResult =
  | {
      status: "applied";
      draftId: DraftId;
      draftClosed: boolean;
      items: readonly ApplyItemResult[];
    }
  | { status: "stale"; draftId: DraftId; staleItemKeys: readonly DraftItemKey[] }
  | { status: "gone"; draftId: DraftId };

/** A selection that names an item twice: refused before anything registers or stages. */
export class DuplicateApplyItemError extends Error {
  constructor(readonly itemKeys: readonly DraftItemKey[]) {
    super(`Each item can be applied once per request: ${itemKeys.join(", ")}`);
    this.name = "DuplicateApplyItemError";
  }
}

/** A ref in the cut that can't register now (connection, timeout, lock): retry the Apply later. */
export class DraftLinkRegistrationFailedError extends Error {
  constructor(
    readonly draftId: DraftId,
    readonly failed: readonly DraftLinkRegistrationFailure[],
  ) {
    super(`Draft ${draftId}'s links could not be registered for Apply; try again`);
    this.name = "DraftLinkRegistrationFailedError";
  }
}

export interface DraftPublication {
  applyItems(input: {
    workId: WorkId;
    draftId: DraftId;
    selection: ApplySelection;
    userId?: UserId;
    /** Apply all and D40: close the draft when nothing stays pending (§2.1). */
    closeWhenEmpty: boolean;
    signal?: AbortSignal;
  }): Promise<ApplyResult>;
}

export function createDraftPublication(deps: {
  drafts: Pick<Drafts, "byIds">;
  reviewItems: Pick<DraftReviewItems, "list">;
  draftLinks: Pick<DraftBranchAheadRegistration, "prepareDraftLinkPublication">;
  push: Pick<BranchPushService, "pushBranchesToLive">;
}): DraftPublication {
  async function activeDraft(draftId: DraftId, workId: WorkId) {
    const [draft] = await deps.drafts.byIds([draftId]);
    return draft?.status === "active" && draft.originWorkId === workId ? draft : null;
  }

  return {
    async applyItems(input) {
      const { draftId } = input;
      if (input.selection.kind === "rendered") {
        const seen = new Set<string>();
        const twice = input.selection.items
          .map((ref) => ref.itemKey)
          .filter((key) => seen.size === seen.add(key).size);
        if (twice.length > 0) throw new DuplicateApplyItemError([...new Set(twice)]);
      }
      if (!(await activeDraft(draftId, input.workId))) return { status: "gone", draftId };
      const current = await deps.reviewItems.list(draftId, { liveTextTokens: false });
      const byKey = new Map(current.map((item) => [item.itemKey, item]));
      const refs: ApplyItemRef[] =
        input.selection.kind === "all_pending"
          ? current.map((item) => ({ itemKey: item.itemKey }))
          : [...input.selection.items];
      // An item the writer saw that is no longer pending (applied, discarded) is stale.
      const missing = refs.filter((ref) => !byKey.has(ref.itemKey)).map((ref) => ref.itemKey);
      if (missing.length > 0) return { status: "stale", draftId, staleItemKeys: missing };
      const selected = refs.map((ref) => ({
        ref,
        item: byKey.get(ref.itemKey) as DraftReviewItem,
      }));
      if (selected.length === 0) {
        return { status: "applied", draftId, draftClosed: false, items: [] };
      }
      const branchIds = [
        ...new Set(selected.flatMap(({ item }) => item.draftBranchId ?? [])),
      ].sort();

      // The cut fence refuses when a branch changed since registration: register again,
      // once; a second change means the writer is typing in review, so the list refreshes.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const prepared = await deps.draftLinks.prepareDraftLinkPublication({ draftId, branchIds });
        if (prepared.status === "registration_failed") {
          throw new DraftLinkRegistrationFailedError(draftId, prepared.failed);
        }
        await collabHook("applyItems.afterLinkCut");
        const payload: DraftTreePayload = {
          draftId,
          closeWhenEmpty: input.closeWhenEmpty,
          linkCut: prepared.cut,
          items: selected.map(({ ref, item }) => ({
            itemKey: item.itemKey,
            documentId: item.documentId,
            draftBranchId: item.draftBranchId,
            origin: item.origin,
            ...(ref.locationToken === undefined ? {} : { locationToken: ref.locationToken }),
            ...(ref.liveTextToken === undefined ? {} : { liveTextToken: ref.liveTextToken }),
            ...(ref.branchGenerationToken === undefined
              ? {}
              : { branchGenerationToken: ref.branchGenerationToken }),
          })),
          holderMeanings: [],
        };
        const pushed = await deps.push.pushBranchesToLive({
          branchIds,
          payloads: { [DRAFT_TREE_STEP]: encodeDraftTreePayload(payload) },
          ...(input.userId ? { pushedByUserId: input.userId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (pushed.refused) {
          const refused = refusalOutcome(pushed.refused, draftId, selected, attempt);
          if (refused === "again") continue;
          return refused;
        }
        const held = new Map(pushed.heldItems.map((hold) => [hold.itemKey, hold.reason]));
        const draftClosed = input.closeWhenEmpty
          ? (await deps.drafts.byIds([draftId]))[0]?.status === "closed"
          : false;
        return {
          status: "applied",
          draftId,
          draftClosed,
          items: selected.map(({ item }): ApplyItemResult => {
            const reason = held.get(item.itemKey);
            return reason
              ? { itemKey: item.itemKey, status: "held", reason: heldReason(reason) }
              : { itemKey: item.itemKey, status: "applied", notes: notesFor(item) };
          }),
        };
      }
      return { status: "stale", draftId, staleItemKeys: selected.map(({ ref }) => ref.itemKey) };
    },
  };
}

function refusalOutcome(
  reason: PublicationRefusal,
  draftId: DraftId,
  selected: readonly { ref: ApplyItemRef }[],
  attempt: number,
): ApplyResult | "again" {
  const refusal = readDraftTreeRefusal(reason);
  switch (refusal?.kind) {
    case "gone":
      return { status: "gone", draftId };
    case "link_cut_changed":
      if (attempt === 0) return "again";
      return { status: "stale", draftId, staleItemKeys: selected.map(({ ref }) => ref.itemKey) };
    case "stale":
      return { status: "stale", draftId, staleItemKeys: refusal.itemKeys };
    default:
      throw new Error(`Apply was refused: ${reason.code}`);
  }
}

function heldReason(reason: PublicationRefusal): HeldReason {
  const held = readDraftTreeHold(reason);
  if (!held) throw new Error(`Apply held an item for a reason it doesn't know: ${reason.code}`);
  return held;
}

/** The receipt notes for an applied item, from what the writer reviewed (§11.2). */
function notesFor(item: DraftReviewItem): ApplyNote[] {
  if (item.conflict?.code === "deleted_live") {
    return [{ code: "restored", path: item.path ?? "" }];
  }
  if (item.conflict?.code === "rename_replaced") {
    return [
      { code: "rename_replaced", replacedPath: item.conflict.livePath, path: item.path ?? "" },
    ];
  }
  return [];
}
