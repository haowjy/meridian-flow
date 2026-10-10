/**
 * Apply as one publication (contract §11): a draft's selected items become one batch on
 * the settlement seam, carrying the `draft_tree` payload the tree step publishes with the
 * text. `applyItems` registers the link cut (§10.8), stages through `pushBranchesToLive`
 * and maps per-item results; the step itself (tokens, holds, vacate and install, arrivals,
 * holder bindings, history, row drop, close) is `adapters/drizzle-draft-tree-step.ts`.
 * Every Apply caller goes through here: the per-document route, Apply all and D40's switch.
 */
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { JsonValue } from "@meridian/contracts/threads";
import type { BranchPushService } from "./branch-push-contracts.js";
import { collabHook } from "./collab-test-hooks.js";
import type {
  DraftBranchAheadRegistration,
  DraftLinkCut,
  DraftLinkRegistrationFailure,
} from "./draft-branch-ahead-registration.js";
import type { DraftReviewItem, DraftReviewItems } from "./draft-review-items.js";
import type { Drafts } from "./drafts.js";
import type { PublicationRefusal } from "./ports/settlement-publication.js";

/** `${DraftId}:${DocumentId}`: one key for every item, text or binary (F12). */
export type DraftItemKey = string;

export function draftItemKey(draftId: DraftId, documentId: DocumentId): DraftItemKey {
  return `${draftId}:${documentId}`;
}

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

export type HeldReason = { code: "path_taken"; path: string };
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

/** The tree step's payload kind; recovery finds the step by it. */
export const DRAFT_TREE_STEP = "draft_tree";

/** One selected item as staged. */
export type DraftTreePayloadItem = {
  itemKey: DraftItemKey;
  documentId: DocumentId;
  /** The text member's branch; null for a branchless item (a created image). */
  draftBranchId: string | null;
  origin: "created" | "edited";
  locationToken?: string;
  liveTextToken?: string;
  branchGenerationToken?: string;
};

/**
 * The `draft_tree` step's durable input (§11.2), immutable once staged. `items` keeps
 * only the items eligible at the pre-staging check; `holderMeanings` is filled there,
 * with the link cut fenced, so completion and recovery bind from this snapshot.
 */
export type DraftTreePayload = {
  draftId: DraftId;
  closeWhenEmpty: boolean;
  linkCut: DraftLinkCut;
  items: readonly DraftTreePayloadItem[];
  holderMeanings: readonly {
    holderDocumentId: DocumentId;
    refs: readonly { aheadId: string; documentId: DocumentId }[];
  }[];
};

export function parseDraftTreePayload(payload: JsonValue | undefined): DraftTreePayload | null {
  if (payload === undefined || payload === null || typeof payload !== "object") return null;
  return payload as unknown as DraftTreePayload;
}

/** The step's refusal codes: `stale` names the items; `link_cut_changed` reruns the prerequisite. */
export const APPLY_REFUSAL = {
  stale: "stale",
  gone: "gone",
  linkCutChanged: "link_cut_changed",
} as const;

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
          payloads: { [DRAFT_TREE_STEP]: payload as unknown as JsonValue },
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
              ? { itemKey: item.itemKey, status: "held", reason: heldReason(reason, item) }
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
  if (reason.code === APPLY_REFUSAL.gone) return { status: "gone", draftId };
  if (reason.code === APPLY_REFUSAL.linkCutChanged && attempt === 0) return "again";
  if (reason.code === APPLY_REFUSAL.stale || reason.code === APPLY_REFUSAL.linkCutChanged) {
    const named = staleKeysIn(reason);
    return {
      status: "stale",
      draftId,
      staleItemKeys: named.length > 0 ? named : selected.map(({ ref }) => ref.itemKey),
    };
  }
  throw new Error(`Apply was refused: ${reason.code}`);
}

function staleKeysIn(reason: PublicationRefusal): DraftItemKey[] {
  const detail = reason.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
  const keys = (detail as { itemKeys?: unknown }).itemKeys;
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [];
}

function heldReason(reason: PublicationRefusal, item: DraftReviewItem): HeldReason {
  const detail = reason.detail as { path?: unknown } | undefined;
  const path = typeof detail?.path === "string" ? detail.path : (item.path ?? "");
  return { code: "path_taken", path };
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
