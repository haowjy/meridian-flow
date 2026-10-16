/**
 * Apply as one publication (contract §2): a draft's chosen items become one batch on the
 * settlement seam. Each text item is a content member (a merge of the change the writer saw into
 * live's current text), staged by `pushBranchesToLive`; the tree work (reveals, restores, holds,
 * arrivals, row drops) rides in the `draft_tree` payload and is the step in
 * `adapters/drizzle-draft-tree-step.ts`. Every Apply caller goes through `applyItems`: the
 * per-document route (the whole item, or its named changes) and Apply all. Apply never closes the
 * draft (§2.4).
 *
 * The command is answered from its stored row. The tree step stores the terminal result in the
 * batch's completion; refusals decided before anything stages (`gone`, `stale`, `whole_item`) are
 * recorded here, so a resend never turns a refusal into an Apply (§1.4).
 */
import type { DocumentId, DraftId, UserId, WorkId } from "@meridian/contracts";
import type {
  DraftApplyAllResult,
  DraftCommandOutcome,
  DraftDecidedOutcome,
} from "@meridian/contracts/drafts";
import type { BranchPushService } from "./branch-push-contracts.js";
import { collabHook } from "./collab-test-hooks.js";
import type { ContentApplyRequest } from "./draft-apply.js";
import type { DraftCommandEnvelope, DraftCommands } from "./draft-commands.js";
import type { DraftReviewIdentity, ResolvedReviewItem } from "./draft-review-identity.js";
import {
  DRAFT_TREE_STEP,
  type DraftItemKey,
  type DraftTreePayload,
  type DraftTreePayloadItem,
  encodeDraftTreePayload,
  readDraftTreeRefusal,
} from "./draft-tree-payload.js";
import type { Drafts } from "./drafts.js";

export {
  type ApplyNote,
  DRAFT_TREE_STEP,
  type DraftItemKey,
  draftItemKey,
  type HeldReason,
} from "./draft-tree-payload.js";

/**
 * What the writer asked of one item. `locationToken` is the tree token from the list row; absent,
 * the server fills it from its own read. `content` absent means the whole item.
 */
export type ApplyItemRef = {
  itemKey: DraftItemKey;
  locationToken?: string;
  content?: ContentApplyRequest;
};

/** The writer's command riding on a publication: claimed at staging, answered at completion. */
export type ApplyCommand = { envelope: DraftCommandEnvelope; shape: "item" | "all" | "changes" };

/**
 * `settled`: the command's row holds its answer (or its batch is staged and will, read the row).
 * `command_exists`: the id already has an effect and the caller answers that row.
 */
export type ApplyOutcome = { status: "settled" } | { status: "command_exists" };

/** A selection that names an item twice: refused before anything registers or stages. */
export class DuplicateApplyItemError extends Error {
  constructor(readonly itemKeys: readonly DraftItemKey[]) {
    super(`Each item can be applied once per request: ${itemKeys.join(", ")}`);
    this.name = "DuplicateApplyItemError";
  }
}

export interface DraftPublication {
  applyItems(input: {
    workId: WorkId;
    draftId: DraftId;
    items: readonly ApplyItemRef[];
    userId: UserId;
    command: ApplyCommand;
    signal?: AbortSignal;
  }): Promise<ApplyOutcome>;
}

export function createDraftPublication(deps: {
  drafts: Pick<Drafts, "byIds">;
  identity: Pick<DraftReviewIdentity, "resolveReviewItem">;
  commands: Pick<DraftCommands, "record">;
  push: Pick<BranchPushService, "pushBranchesToLive" | "settleUnfinished">;
}): DraftPublication {
  async function activeDraft(draftId: DraftId, workId: WorkId) {
    const [draft] = await deps.drafts.byIds([draftId]);
    return draft?.status === "active" && draft.originWorkId === workId ? draft : null;
  }

  /** The refusal as the command's own answer: item routes name the item, Apply all the draft. */
  function refusalResult(
    command: ApplyCommand,
    draftId: DraftId,
    status: "gone" | "stale" | "whole_item",
    itemKeys: readonly DraftItemKey[],
  ): DraftCommandOutcome {
    if (command.shape === "all") {
      if (status === "stale") {
        return {
          status: "stale",
          draftId,
          staleItemKeys: [...itemKeys],
        } satisfies DraftApplyAllResult;
      }
      return { status: "gone", draftId };
    }
    const itemKey = itemKeys[0] ?? "";
    return status === "gone" ? { status, draftId, itemKey } : { status, draftId, itemKey };
  }

  /** What one pass publishes: built fresh each pass, so a retry re-reads the draft. */
  interface PublicationPlan {
    members: { branchId: string; itemKey: DraftItemKey; request: ContentApplyRequest }[];
    itemKeys: DraftItemKey[];
    items: DraftTreePayloadItem[];
    /** A stale answer from a tokenless selection was read before a change: read again, once. */
    rereadStale: boolean;
    documentIds: DocumentId[];
  }

  return {
    async applyItems(input) {
      const { draftId, command } = input;
      const seen = new Set<string>();
      const twice = input.items
        .map((ref) => ref.itemKey)
        .filter((key) => seen.size === seen.add(key).size);
      if (twice.length > 0) throw new DuplicateApplyItemError([...new Set(twice)]);
      const record = async (
        status: "gone" | "stale" | "whole_item",
        itemKeys: readonly DraftItemKey[],
      ): Promise<ApplyOutcome> => {
        await deps.commands.record(
          command.envelope,
          refusalResult(command, draftId, status, itemKeys),
        );
        return { status: "settled" };
      };
      const itemKeys = input.items.map((ref) => ref.itemKey);
      if (!(await activeDraft(draftId, input.workId))) return record("gone", itemKeys);

      const tokenless = input.items.every((ref) => ref.locationToken === undefined);
      let readAgain = false;
      for (;;) {
        // Resolved through the resolver: an item the writer emptied locally after the list
        // rendered is unlisted but still addressable, and plans normally (§4.3).
        const resolved = await Promise.all(
          input.items.map(async (ref) => ({
            ref,
            item: await deps.identity.resolveReviewItem({
              workId: input.workId,
              itemKey: ref.itemKey,
            }),
          })),
        );
        const missing = resolved.filter(({ item }) => !item).map(({ ref }) => ref.itemKey);
        if (missing.length > 0) return record("stale", missing);
        const chosen = resolved.map(({ ref, item }) => ({
          ref,
          item: (item as ResolvedReviewItem).item,
        }));
        // A change of a created, binary or live-deleted item is the whole item: refused.
        const whole = chosen.find(
          ({ ref, item }) => ref.content?.scope === "changes" && item.wholeItem,
        );
        if (whole) return record("whole_item", [whole.ref.itemKey]);

        const plan: PublicationPlan = {
          members: chosen.flatMap(({ ref, item }) =>
            item.draftBranchId
              ? [
                  {
                    branchId: item.draftBranchId,
                    itemKey: item.itemKey,
                    request: ref.content ?? ({ scope: "item" } as const),
                  },
                ]
              : [],
          ),
          itemKeys,
          items: chosen.map(({ ref, item }) => ({
            itemKey: item.itemKey,
            documentId: item.documentId,
            draftBranchId: item.draftBranchId,
            origin: item.origin,
            locationToken: ref.locationToken ?? item.tokens.locationToken,
          })),
          rereadStale: tokenless,
          documentIds: chosen.flatMap(({ item }) => (item.draftBranchId ? [item.documentId] : [])),
        };
        // Settle what an earlier Apply left staged on these documents before any lease is
        // held: its settlement takes the same leases, and the lease lock is not re-entrant.
        // Whatever stays unfinished is decided again under the leases.
        if (plan.documentIds.length > 0) {
          await deps.push.settleUnfinished(plan.documentIds, input.signal);
        }

        const payload = (decided: readonly DraftDecidedOutcome[]): DraftTreePayload => {
          const dropped = new Set(
            decided
              .filter((outcome) => outcome.status === "failed" || outcome.status === "not_found")
              .map((outcome) => outcome.itemKey),
          );
          return {
            draftId,
            command: { shape: command.shape, itemKeys: plan.itemKeys, decided: [...decided] },
            // A failed or unfound item's tree effects are excluded: nothing is revealed without
            // the content its Apply asked for.
            items: plan.items.filter((item) => !dropped.has(item.itemKey)),
          };
        };
        await collabHook("applyItems.beforeStaging");
        const pushed = await deps.push.pushBranchesToLive({
          members: plan.members,
          payloads: { [DRAFT_TREE_STEP]: encodeDraftTreePayload(payload([])) },
          finalizePayloads: (decided) => ({
            [DRAFT_TREE_STEP]: encodeDraftTreePayload(payload(decided)),
          }),
          command: command.envelope,
          pushedByUserId: input.userId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (pushed.commandExists) return { status: "command_exists" };
        if (pushed.refused) {
          const refusal = readDraftTreeRefusal(pushed.refused);
          if (!refusal) throw new Error(`Apply was refused: ${pushed.refused.code}`);
          if (refusal.kind === "gone") return record("gone", itemKeys);
          if (refusal.kind === "stale" && plan.rereadStale && !readAgain) {
            readAgain = true;
            continue;
          }
          return record("stale", refusal.itemKeys.length > 0 ? refusal.itemKeys : plan.itemKeys);
        }
        return { status: "settled" };
      }
    },
  };
}
