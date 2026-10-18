/**
 * Apply as one settlement (contract §11): a branch's selected items become one batch on
 * the settlement seam, carrying the `branch_tree` payload the tree step lands with the
 * text. `applyItems` stages through `pushDraftsToLive` and maps per-item results; the
 * step itself (tokens, holds, vacate and install, arrivals, history, row drop, close) is `adapters/drizzle-branch-tree-step.ts`.
 * Every Apply caller goes through here: the per-document route, per-change Apply (its rows
 * chosen at the revision staging commits at, §4.1), and Apply all. Apply never closes the
 * branch (§2.4). A writer's command is claimed in the staging transaction and settled by the
 * tree step in completion (§4.6).
 */
import type { BranchId, UserId, WorkId } from "@meridian/contracts";
import type { BranchApplyAllResponse, DraftApplyItemResult } from "@meridian/contracts/branches";
import type { BranchCommandEnvelope } from "./branch-commands.js";
import type {
  BranchPushService,
  ChangeApplySelection,
  ReviewRowSelection,
} from "./branch-push-contracts.js";
import { BranchPushRetryExhaustedError } from "./branch-push-contracts.js";
import { PendingLiveSettlementError } from "./branch-push-transition.js";
import type { BranchReviewItems, DraftReviewItem } from "./branch-review-items.js";
import {
  BRANCH_TREE_STEP,
  type BranchTreePayload,
  type DraftItemKey,
  encodeBranchTreePayload,
  type HeldReason,
  readBranchTreeHold,
  readBranchTreeNotes,
  readBranchTreeRefusal,
} from "./branch-tree-payload.js";
import type { Branches } from "./branches.js";
import { collabHook } from "./collab-test-hooks.js";
import type { DraftJournalRow } from "./draft-journal.js";
import type { DraftSnapshot } from "./draft-store.js";
import type { ApplyRefusal } from "./ports/settlement-apply.js";

export {
  type ApplyNote,
  BRANCH_TREE_STEP,
  type DraftItemKey,
  draftItemKey,
  type HeldReason,
} from "./branch-tree-payload.js";

/**
 * What the writer was shown of one item. A token absent (the legacy per-document Apply
 * without tokens) is filled from the read `applyItems` makes, so
 * what applies is what that read saw; a selection with no tokens of its own that turns
 * out stale reads again once.
 */
export type ApplyItemRef = {
  itemKey: DraftItemKey;
  locationToken?: string;
  liveTextToken?: string;
  draftGenerationToken?: string;
};

export type ApplySelection = { kind: "rendered"; items: readonly ApplyItemRef[] };

/** Per-item and whole results are the wire's own types (`@meridian/contracts/branches`). */
export type ApplyItemResult = DraftApplyItemResult;
export type ApplyResult = Exclude<BranchApplyAllResponse, { status: "pending" }>;

/** The writer's command riding on an Apply: claimed at staging, answered at completion. */
export type ApplyCommand = { envelope: BranchCommandEnvelope; shape: "item" | "all" | "changes" };

/** A command's id already has an effect: the caller answers the stored command. */
export type ApplyOutcome = ApplyResult | { status: "command_exists" };

/** What per-change Apply selected on a staging attempt's read: its rows, fence and rendered basis. */
export type ChangeSelection = ReviewRowSelection & {
  operationIds: readonly string[];
  closureClassIds: readonly string[];
  /** The rendered basis the selection validated the client's token against (§4.1). */
  locationToken: string;
  draftGenerationToken: string;
};

/** A selection that names an item twice: refused before anything registers or stages. */
export class DuplicateApplyItemError extends Error {
  constructor(readonly itemKeys: readonly DraftItemKey[]) {
    super(`Each item can be applied once per request: ${itemKeys.join(", ")}`);
    this.name = "DuplicateApplyItemError";
  }
}

/** The staged Apply belongs to recovery; the transport must acknowledge acceptance (F27). */
export class BranchApplyPendingError extends Error {
  constructor(
    readonly branchId: BranchId,
    cause: PendingLiveSettlementError,
  ) {
    super("Your drafts are being applied in the background.", { cause });
    this.name = "BranchApplyPendingError";
  }
}

export interface BranchApply {
  applyItems(input: {
    workId: WorkId;
    branchId: BranchId;
    selection: ApplySelection;
    userId?: UserId;
    command?: ApplyCommand;
    signal?: AbortSignal;
  }): Promise<ApplyOutcome>;
  /** One item's selected changes, applied as exact rows; the selection runs on each attempt's read. */
  applyChanges(input: {
    workId: WorkId;
    item: DraftReviewItem;
    userId: UserId;
    command: ApplyCommand;
    select(documentDraft: DraftSnapshot, rows: DraftJournalRow[]): Promise<ChangeSelection>;
    signal?: AbortSignal;
  }): Promise<ApplyOutcome>;
}

export function createBranchApply(deps: {
  branches: Pick<Branches, "byIds">;
  reviewItems: Pick<BranchReviewItems, "list" | "withLiveTextTokens">;
  push: Pick<BranchPushService, "pushDraftsToLive">;
}): BranchApply {
  async function activeBranch(branchId: BranchId, workId: WorkId) {
    const [branch] = await deps.branches.byIds([branchId]);
    return branch?.status === "active" && branch.originWorkId === workId ? branch : null;
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
      draftId: item.draftId,
      origin: item.origin,
      locationToken: ref.locationToken ?? item.tokens.locationToken,
      liveTextToken: ref.liveTextToken ?? read.get(item.itemKey)?.tokens.liveTextToken ?? null,
      draftGenerationToken: ref.draftGenerationToken ?? item.tokens.draftGenerationToken,
      selection: null,
    }));
  }

  /** What one pass applies: built fresh each pass, so a retry re-reads the branch. */
  interface ApplyPlan {
    draftIds: string[];
    itemKeys: string[];
    payload: BranchTreePayload;
    selected?: ChangeApplySelection;
    /** A stale answer from a tokenless selection was read before a change: read again, once. */
    rereadStale: boolean;
  }

  /**
   * One Apply loop: stage, push, settle the answer. A tokenless selection whose
   * tokens went stale is planned again, once.
   */
  async function applyBatch(input: {
    branchId: BranchId;
    userId?: UserId;
    command?: ApplyCommand;
    signal?: AbortSignal;
    plan(): Promise<ApplyPlan | ApplyOutcome>;
  }): Promise<ApplyOutcome> {
    const { branchId } = input;
    let readAgain = false;
    for (;;) {
      const plan = await input.plan();
      if ("status" in plan) return plan;
      await collabHook("applyItems.beforeStaging");
      const pushed = await deps.push
        .pushDraftsToLive({
          draftIds: plan.draftIds,
          payloads: { [BRANCH_TREE_STEP]: encodeBranchTreePayload(plan.payload) },
          ...(input.command ? { command: input.command.envelope } : {}),
          ...(input.userId ? { pushedByUserId: input.userId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(plan.selected ? { selected: plan.selected } : {}),
        })
        .catch((cause: unknown) => {
          // The batch staged but settlement handed it to recovery: it finishes there.
          if (cause instanceof PendingLiveSettlementError) {
            throw new BranchApplyPendingError(branchId, cause);
          }
          // Four staging attempts each found a draft moved under them (a writer typing):
          // nothing was staged and nothing claimed, so the items answer as stale do.
          if (cause instanceof BranchPushRetryExhaustedError) return null;
          throw cause;
        });
      if (!pushed) return { status: "stale", branchId, staleItemKeys: plan.itemKeys };
      if (pushed.commandExists) return { status: "command_exists" };
      if (pushed.refused) {
        const refusal = readBranchTreeRefusal(pushed.refused);
        if (!refusal) throw new Error(`Apply was refused: ${pushed.refused.code}`);
        if (refusal.kind === "gone") return { status: "gone", branchId };
        if (refusal.kind === "stale" && plan.rereadStale && !readAgain) {
          readAgain = true;
          continue;
        }
        return {
          status: "stale",
          branchId,
          staleItemKeys: refusal.kind === "stale" ? [...refusal.itemKeys] : plan.itemKeys,
        };
      }
      const held = new Map(pushed.heldItems.map((hold) => [hold.itemKey, hold.reason]));
      const notes = new Map(
        pushed.outcomes.map((outcome) => [outcome.itemKey, readBranchTreeNotes(outcome.detail)]),
      );
      return {
        status: "completed",
        branchId,
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
      const { branchId } = input;
      const seen = new Set<string>();
      const twice = input.selection.items
        .map((ref) => ref.itemKey)
        .filter((key) => seen.size === seen.add(key).size);
      if (twice.length > 0) throw new DuplicateApplyItemError([...new Set(twice)]);
      if (!(await activeBranch(branchId, input.workId))) return { status: "gone", branchId };
      const { selection } = input;
      const tokenless = selection.items.every(
        (ref) =>
          ref.locationToken === undefined &&
          ref.liveTextToken === undefined &&
          ref.draftGenerationToken === undefined,
      );
      return applyBatch({
        branchId,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.command ? { command: input.command } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        async plan() {
          const current = await deps.reviewItems.list(branchId);
          const byKey = new Map(current.map((item) => [item.itemKey, item]));
          const refs = selection.items;
          // An item the writer saw that is no longer pending (applied, discarded) is stale.
          const missing = refs.filter((ref) => !byKey.has(ref.itemKey)).map((ref) => ref.itemKey);
          if (missing.length > 0) return { status: "stale", branchId, staleItemKeys: missing };
          const chosen = refs.map((ref) => ({
            ref,
            item: byKey.get(ref.itemKey) as DraftReviewItem,
          }));
          const items = await withTokens(chosen);
          const itemKeys = items.map((item) => item.itemKey);
          return {
            draftIds: [...new Set(chosen.flatMap(({ item }) => item.draftId ?? []))].sort(),
            itemKeys,
            rereadStale: tokenless,
            payload: {
              branchId,
              command: input.command ? { shape: input.command.shape, itemKeys } : null,
              items,
            },
          };
        },
      });
    },

    async applyChanges(input) {
      const { item } = input;
      const { branchId } = item;
      const draftId = item.draftId;
      if (!draftId || !(await activeBranch(branchId, input.workId))) {
        return { status: "gone", branchId };
      }
      const entry = {
        itemKey: item.itemKey,
        documentId: item.documentId,
        draftId: draftId,
        origin: item.origin,
        locationToken: item.tokens.locationToken,
        liveTextToken: null,
        draftGenerationToken: item.tokens.draftGenerationToken,
        selection: { operationIds: [], closureClassIds: [] },
      };
      const payload = (chosen?: ChangeSelection) =>
        ({
          branchId,
          command: { shape: input.command.shape, itemKeys: [item.itemKey] },
          items: [
            chosen
              ? {
                  ...entry,
                  locationToken: chosen.locationToken,
                  draftGenerationToken: chosen.draftGenerationToken,
                  selection: {
                    operationIds: [...chosen.operationIds],
                    closureClassIds: [...chosen.closureClassIds],
                  },
                }
              : entry,
          ],
        }) satisfies BranchTreePayload;
      return applyBatch({
        branchId,
        userId: input.userId,
        command: input.command,
        ...(input.signal ? { signal: input.signal } : {}),
        async plan() {
          return {
            draftIds: [draftId],
            itemKeys: [item.itemKey],
            rereadStale: false,
            payload: payload(),
            selected: {
              draftId,
              select: async (documentDraft, rows) => {
                const chosen = await input.select(documentDraft, rows);
                return {
                  journalIds: chosen.journalIds,
                  expectedLiveRevision: chosen.expectedLiveRevision,
                  payloads: {
                    [BRANCH_TREE_STEP]: encodeBranchTreePayload(payload(chosen)),
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

function heldReason(reason: ApplyRefusal): HeldReason {
  const held = readBranchTreeHold(reason);
  if (!held) throw new Error(`Apply held an item for a reason it doesn't know: ${reason.code}`);
  return held;
}
