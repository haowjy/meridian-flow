/**
 * Apply as one publication (contract §11): a draft's selected items become one batch on
 * the settlement seam, carrying the `draft_tree` payload the tree step publishes with the
 * text. `applyItems` stages through `pushBranchesToLive` and maps per-item results; the
 * step itself (tokens, holds, vacate and install, arrivals, history, row drop, close) is `adapters/drizzle-draft-tree-step.ts`.
 * Every Apply caller goes through here: the per-document route, per-change Apply (its rows
 * chosen under the branch lease, §4.1), and Apply all. Apply never closes the
 * draft (§2.4). A writer's command is claimed in the staging transaction and settled by the
 * tree step in completion (§4.6).
 */
import type { DraftId, UserId, WorkId } from "@meridian/contracts";
import type { DraftApplyAllResponse, DraftApplyItemResult } from "@meridian/contracts/drafts";
import type { BranchJournalRow } from "./branch-journal.js";
import type {
  BranchPushService,
  ReviewRowSelection,
  SelectedPublication,
} from "./branch-push-contracts.js";
import { BranchPushRetryExhaustedError } from "./branch-push-contracts.js";
import { PendingLiveSettlementError } from "./branch-push-transition.js";
import type { BranchSnapshot } from "./branch-store.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftCommandEnvelope } from "./draft-commands.js";
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

/** The writer's command riding on a publication: claimed at staging, answered at completion. */
export type ApplyCommand = { envelope: DraftCommandEnvelope; shape: "item" | "all" | "changes" };

/** A command's id already has an effect: the caller answers the stored command. */
export type ApplyOutcome = ApplyResult | { status: "command_exists" };

/** What per-change Apply selected on a staging attempt's read: its rows, fence and rendered basis. */
export type ChangeSelection = ReviewRowSelection & {
  operationIds: readonly string[];
  closureClassIds: readonly string[];
  /** The rendered basis the selection validated the client's token against (§4.1). */
  locationToken: string;
  branchGenerationToken: string;
};

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
    cause: PendingLiveSettlementError,
  ) {
    super("The draft is finishing in the background.", { cause });
    this.name = "DraftApplyPendingError";
  }
}

export interface DraftPublication {
  applyItems(input: {
    workId: WorkId;
    draftId: DraftId;
    selection: ApplySelection;
    userId?: UserId;
    command?: ApplyCommand;
    signal?: AbortSignal;
  }): Promise<ApplyOutcome>;
  /** One item's selected changes, published as exact rows; the selection runs on each attempt's read. */
  applyChanges(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    command: ApplyCommand;
    select(branch: BranchSnapshot, rows: BranchJournalRow[]): Promise<ChangeSelection>;
    signal?: AbortSignal;
  }): Promise<ApplyOutcome>;
}

export function createDraftPublication(deps: {
  drafts: Pick<Drafts, "byIds">;
  reviewItems: Pick<DraftReviewItems, "list" | "withLiveTextTokens">;
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
      selection: null,
    }));
  }

  /** What one pass publishes: built fresh each pass, so a retry re-reads the draft. */
  interface PublicationPlan {
    branchIds: string[];
    itemKeys: string[];
    payload: DraftTreePayload;
    selected?: SelectedPublication;
    /** A stale answer from a tokenless selection was read before a change: read again, once. */
    rereadStale: boolean;
  }

  /**
   * One publication loop: stage, push, settle the answer. A tokenless selection whose
   * tokens went stale is planned again, once.
   */
  async function publish(input: {
    draftId: DraftId;
    userId?: UserId;
    command?: ApplyCommand;
    signal?: AbortSignal;
    plan(): Promise<PublicationPlan | ApplyOutcome>;
  }): Promise<ApplyOutcome> {
    const { draftId } = input;
    let readAgain = false;
    for (;;) {
      const plan = await input.plan();
      if ("status" in plan) return plan;
      await collabHook("applyItems.beforeStaging");
      const pushed = await deps.push
        .pushBranchesToLive({
          branchIds: plan.branchIds,
          payloads: { [DRAFT_TREE_STEP]: encodeDraftTreePayload(plan.payload) },
          ...(input.command ? { command: input.command.envelope } : {}),
          ...(input.userId ? { pushedByUserId: input.userId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(plan.selected ? { selected: plan.selected } : {}),
        })
        .catch((cause: unknown) => {
          // The batch staged but settlement handed it to recovery: it finishes there.
          if (cause instanceof PendingLiveSettlementError) {
            throw new DraftApplyPendingError(draftId, cause);
          }
          // Four staging attempts each found a draft moved under them (a writer typing):
          // nothing was staged and nothing claimed, so the items answer as stale do.
          if (cause instanceof BranchPushRetryExhaustedError) return null;
          throw cause;
        });
      if (!pushed) return { status: "stale", draftId, staleItemKeys: plan.itemKeys };
      if (pushed.commandExists) return { status: "command_exists" };
      if (pushed.refused) {
        const refusal = readDraftTreeRefusal(pushed.refused);
        if (!refusal) throw new Error(`Apply was refused: ${pushed.refused.code}`);
        if (refusal.kind === "gone") return { status: "gone", draftId };
        if (refusal.kind === "stale" && plan.rereadStale && !readAgain) {
          readAgain = true;
          continue;
        }
        return {
          status: "stale",
          draftId,
          staleItemKeys: refusal.kind === "stale" ? [...refusal.itemKeys] : plan.itemKeys,
        };
      }
      const held = new Map(pushed.heldItems.map((hold) => [hold.itemKey, hold.reason]));
      const notes = new Map(
        pushed.outcomes.map((outcome) => [outcome.itemKey, readDraftTreeNotes(outcome.detail)]),
      );
      return {
        status: "completed",
        draftId,
        items: plan.itemKeys.map((itemKey): ApplyItemResult => {
          const reason = held.get(itemKey);
          return reason
            ? { itemKey, status: "held", reason: heldReason(reason) }
            : { itemKey, status: "applied", notes: notes.get(itemKey) ?? [] };
        }),
      };
    }
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
      const { selection } = input;
      const tokenless = selection.items.every(
        (ref) =>
          ref.locationToken === undefined &&
          ref.liveTextToken === undefined &&
          ref.branchGenerationToken === undefined,
      );
      return publish({
        draftId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        async plan() {
          const current = await deps.reviewItems.list(draftId);
          const byKey = new Map(current.map((item) => [item.itemKey, item]));
          const refs = selection.items;
          // An item the writer saw that is no longer pending (applied, discarded) is stale.
          const missing = refs.filter((ref) => !byKey.has(ref.itemKey)).map((ref) => ref.itemKey);
          if (missing.length > 0) return { status: "stale", draftId, staleItemKeys: missing };
          const chosen = refs.map((ref) => ({
            ref,
            item: byKey.get(ref.itemKey) as DraftReviewItem,
          }));
          const items = await withTokens(chosen);
          const itemKeys = items.map((item) => item.itemKey);
          return {
            branchIds: [...new Set(chosen.flatMap(({ item }) => item.draftBranchId ?? []))].sort(),
            itemKeys,
            rereadStale: tokenless,
            payload: {
              draftId,
              command: input.command ? { shape: input.command.shape, itemKeys } : null,
              items,
            },
          };
        },
      });
    },

    async applyChanges(input) {
      const { item } = input;
      const { draftId } = item;
      const branchId = item.draftBranchId;
      if (!branchId || !(await activeDraft(draftId, input.workId))) {
        return { status: "gone", draftId };
      }
      const entry = {
        itemKey: item.itemKey,
        documentId: item.documentId,
        draftBranchId: branchId,
        origin: item.origin,
        locationToken: item.tokens.locationToken,
        liveTextToken: null,
        branchGenerationToken: item.tokens.branchGenerationToken,
        selection: { operationIds: [], closureClassIds: [] },
      };
      const payload = (chosen?: ChangeSelection) =>
        ({
          draftId,
          command: { shape: input.command.shape, itemKeys: [item.itemKey] },
          items: [
            chosen
              ? {
                  ...entry,
                  locationToken: chosen.locationToken,
                  branchGenerationToken: chosen.branchGenerationToken,
                  selection: {
                    operationIds: [...chosen.operationIds],
                    closureClassIds: [...chosen.closureClassIds],
                  },
                }
              : entry,
          ],
        }) satisfies DraftTreePayload;
      return publish({
        draftId,
        userId: input.userId,
        command: input.command,
        ...(input.signal ? { signal: input.signal } : {}),
        async plan() {
          return {
            branchIds: [branchId],
            itemKeys: [item.itemKey],
            rereadStale: false,
            payload: payload(),
            selected: {
              branchId,
              select: async (branch, rows) => {
                const chosen = await input.select(branch, rows);
                return {
                  journalIds: chosen.journalIds,
                  expectedLiveRevision: chosen.expectedLiveRevision,
                  payloads: {
                    [DRAFT_TREE_STEP]: encodeDraftTreePayload(payload(chosen)),
                  },
                };
              },
            },
          };
        },
      });
    },
  };
}

function heldReason(reason: PublicationRefusal): HeldReason {
  const held = readDraftTreeHold(reason);
  if (!held) throw new Error(`Apply held an item for a reason it doesn't know: ${reason.code}`);
  return held;
}
