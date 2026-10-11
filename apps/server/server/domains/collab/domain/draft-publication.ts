/**
 * Apply as one publication (contract §11): a draft's selected items become one batch on
 * the settlement seam, carrying the `draft_tree` payload the tree step publishes with the
 * text. `applyItems` registers the link cut (§10.8), stages through `pushBranchesToLive`
 * and maps per-item results; the step itself (tokens, holds, vacate and install, arrivals,
 * holder bindings, history, row drop, close) is `adapters/drizzle-draft-tree-step.ts`.
 * Every Apply caller goes through here: the per-document route and Apply all.
 */
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftApplyAllResponse, DraftApplyItemResult } from "@meridian/contracts/drafts";
import type { BranchPushService } from "./branch-push-contracts.js";
import { PublicationLeasesChangedError } from "./branch-push-transition.js";
import { collabHook } from "./collab-test-hooks.js";
import type {
  DraftBranchAheadRegistration,
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
  readDraftTreeNotes,
  readDraftTreeRefusal,
} from "./draft-tree-payload.js";
import type { Drafts } from "./drafts.js";
import type { PublicationRefusal } from "./ports/settlement-publication.js";

export {
  type ApplyNote,
  DRAFT_TREE_STEP,
  type DraftItemKey,
  draftItemKey,
  type HeldReason,
} from "./draft-tree-payload.js";

/**
 * What the writer was shown of one item. A token absent (the legacy per-document Apply
 * without tokens) is filled from the read `applyItems` makes, so
 * what publishes is what that read saw; a selection with no tokens of its own that turns
 * out stale reads again once.
 */
export type ApplyItemRef = {
  itemKey: DraftItemKey;
  locationToken?: string;
  liveTextToken?: string;
  branchGenerationToken?: string;
};

export type ApplySelection = { kind: "rendered"; items: readonly ApplyItemRef[] };

/** Per-item and whole results are the wire's own types (`@meridian/contracts/drafts`). */
export type ApplyItemResult = DraftApplyItemResult;
export type ApplyResult = Exclude<DraftApplyAllResponse, { status: "pending" }>;

/** A selection that names an item twice: refused before anything registers or stages. */
export class DuplicateApplyItemError extends Error {
  constructor(readonly itemKeys: readonly DraftItemKey[]) {
    super(`Each item can be applied once per request: ${itemKeys.join(", ")}`);
    this.name = "DuplicateApplyItemError";
  }
}

/** The staged Apply belongs to recovery; the transport must acknowledge acceptance (F27). */
export class DraftApplyPendingError extends Error {
  constructor(
    readonly draftId: DraftId,
    cause: PublicationLeasesChangedError,
  ) {
    super("The draft is finishing in the background.", { cause });
    this.name = "DraftApplyPendingError";
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
    /** Apply all: close the draft when nothing stays pending (§2.1). */
    closeWhenEmpty: boolean;
    signal?: AbortSignal;
  }): Promise<ApplyResult>;
}

export function createDraftPublication(deps: {
  drafts: Pick<Drafts, "byIds">;
  reviewItems: Pick<DraftReviewItems, "list" | "withLiveTextTokens">;
  draftLinks: Pick<DraftBranchAheadRegistration, "prepareDraftLinkPublication">;
  push: Pick<BranchPushService, "pushBranchesToLive">;
}): DraftPublication {
  async function activeDraft(draftId: DraftId, workId: WorkId) {
    const [draft] = await deps.drafts.byIds([draftId]);
    return draft?.status === "active" && draft.originWorkId === workId ? draft : null;
  }

  /** Each selected item with every token the payload needs: the ref's, else the read's. */
  async function withTokens(selected: readonly { ref: ApplyItemRef; item: DraftReviewItem }[]) {
    const unread = selected
      .filter(({ ref }) => ref.liveTextToken === undefined)
      .map(({ item }) => item);
    const read = new Map(
      (await deps.reviewItems.withLiveTextTokens(unread)).map((item) => [item.itemKey, item]),
    );
    return selected.map(({ ref, item }) => ({
      itemKey: item.itemKey,
      documentId: item.documentId,
      draftBranchId: item.draftBranchId,
      origin: item.origin,
      locationToken: ref.locationToken ?? item.tokens.locationToken,
      liveTextToken: ref.liveTextToken ?? read.get(item.itemKey)?.tokens.liveTextToken ?? null,
      branchGenerationToken: ref.branchGenerationToken ?? item.tokens.branchGenerationToken,
    }));
  }

  return {
    async applyItems(input) {
      const { draftId } = input;
      const seen = new Set<string>();
      const twice = input.selection.items
        .map((ref) => ref.itemKey)
        .filter((key) => seen.size === seen.add(key).size);
      if (twice.length > 0) throw new DuplicateApplyItemError([...new Set(twice)]);
      if (!(await activeDraft(draftId, input.workId))) return { status: "gone", draftId };
      const tokenless = input.selection.items.every(
        (ref) =>
          ref.locationToken === undefined &&
          ref.liveTextToken === undefined &&
          ref.branchGenerationToken === undefined,
      );
      let registeredAgain = false;
      let readAgain = false;
      // Each pass reads the draft, registers the link cut and publishes. The cut fence (F18)
      // refuses when a branch changed since registration: register again, once. A
      // selection with no tokens of its own that turns out stale was read before a change
      // the writer never saw: read again, once.
      for (;;) {
        const current = await deps.reviewItems.list(draftId);
        const byKey = new Map(current.map((item) => [item.itemKey, item]));
        const refs = input.selection.items;
        // An item the writer saw that is no longer pending (applied, discarded) is stale.
        const missing = refs.filter((ref) => !byKey.has(ref.itemKey)).map((ref) => ref.itemKey);
        if (missing.length > 0) return { status: "stale", draftId, staleItemKeys: missing };
        const selected = refs.map((ref) => ({
          ref,
          item: byKey.get(ref.itemKey) as DraftReviewItem,
        }));
        const branchIds = [
          ...new Set(selected.flatMap(({ item }) => item.draftBranchId ?? [])),
        ].sort();
        const items = await withTokens(selected);

        const prepared = await deps.draftLinks.prepareDraftLinkPublication({ draftId, branchIds });
        if (prepared.status === "registration_failed") {
          throw new DraftLinkRegistrationFailedError(draftId, prepared.failed);
        }
        await collabHook("applyItems.afterLinkCut");
        const payload: DraftTreePayload = {
          draftId,
          closeWhenEmpty: input.closeWhenEmpty,
          linkCut: prepared.cut,
          items,
          holderMeanings: [],
        };
        const pushed = await deps.push
          .pushBranchesToLive({
            branchIds,
            payloads: { [DRAFT_TREE_STEP]: encodeDraftTreePayload(payload) },
            ...(input.userId ? { pushedByUserId: input.userId } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
          .catch((cause: unknown) => {
            if (cause instanceof PublicationLeasesChangedError) {
              throw new DraftApplyPendingError(draftId, cause);
            }
            throw cause;
          });
        if (pushed.refused) {
          const refusal = readDraftTreeRefusal(pushed.refused);
          if (!refusal) throw new Error(`Apply was refused: ${pushed.refused.code}`);
          if (refusal.kind === "gone") return { status: "gone", draftId };
          if (refusal.kind === "link_cut_changed" && !registeredAgain) {
            registeredAgain = true;
            continue;
          }
          if (refusal.kind === "stale" && tokenless && !readAgain) {
            readAgain = true;
            continue;
          }
          return {
            status: "stale",
            draftId,
            staleItemKeys:
              refusal.kind === "stale" ? [...refusal.itemKeys] : items.map((item) => item.itemKey),
          };
        }
        const held = new Map(pushed.heldItems.map((hold) => [hold.itemKey, hold.reason]));
        const notes = new Map(
          pushed.outcomes.map((outcome) => [outcome.itemKey, readDraftTreeNotes(outcome.detail)]),
        );
        const draftClosed = input.closeWhenEmpty
          ? (await deps.drafts.byIds([draftId]))[0]?.status === "closed"
          : false;
        return {
          status: "completed",
          draftId,
          draftClosed,
          items: items.map(({ itemKey }): ApplyItemResult => {
            const reason = held.get(itemKey);
            return reason
              ? { itemKey, status: "held", reason: heldReason(reason) }
              : { itemKey, status: "applied", notes: notes.get(itemKey) ?? [] };
          }),
        };
      }
    },
  };
}

function heldReason(reason: PublicationRefusal): HeldReason {
  const held = readDraftTreeHold(reason);
  if (!held) throw new Error(`Apply held an item for a reason it doesn't know: ${reason.code}`);
  return held;
}
