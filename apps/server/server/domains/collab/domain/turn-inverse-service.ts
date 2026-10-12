/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import {
  type ComputedInverse,
  computeInverse,
  type InversePart,
  type InverseSelection,
  inspectEditRoots,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type {
  ReversalOutcome,
  TurnInverseSkip,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import type { EditOrigin, EditPlacement } from "@meridian/database";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  consumes: string[];
  origin: EditOrigin;
  placement: EditPlacement;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId: TurnId;
  responseId?: string;
  documentIds?: DocumentId[];
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  live: Y.Doc;
  history: StoredInversePart[];
  drafts: ReadonlyMap<
    string,
    { branch: BranchSnapshot; doc: Y.Doc; name: string; frozen: boolean }
  >;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  branchId: string | null;
  computed: ComputedInverse;
  consumes: string[];
  skips: TurnInverseSkip[];
  heldDraftIds: string[];
};
export interface TurnInverseStore {
  markBlocking(branchIds: string[]): Promise<void>;
  /** Transition locks, all process locks, Work rows, then admission locks. */
  withLockedDocuments<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T>;
  commit(input: {
    plans: PreparedDocumentInverse[];
    kind: "undo" | "redo" | "rollback";
    userId?: UserId;
    query: TurnInverseQuery;
  }): Promise<void>;
  describePart(
    document: InverseDocument,
    part: StoredInversePart,
  ): { before: string; after: string };
}
const partKey = (part: { editId: string; ordinal: number }) => `${part.editId}:${part.ordinal}`;
const eligiblePlacement = (part: StoredInversePart) =>
  part.placement.kind === "pending" || part.placement.kind === "live";
const targetsTurn = (part: StoredInversePart, query: TurnInverseQuery) =>
  part.kind === "write" &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  (!query.responseId || part.responseId === query.responseId);

/** One selection and one destination per document, for both command and dry run. */
function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  direction: "undo" | "redo",
  actionId: string,
): PreparedDocumentInverse[] {
  const originals = documents.flatMap((document) =>
    document.history.filter((part) => targetsTurn(part, query)),
  );
  const keys = new Set(originals.map(partKey));
  const all = documents.flatMap((document) => document.history).sort((a, b) => a.id - b.id);
  const undoActions = [
    ...new Set(
      all
        .filter(
          (part) =>
            part.kind === "undo" &&
            part.actionId &&
            eligiblePlacement(part) &&
            part.targets.some((target) => keys.has(partKey(target))),
        )
        .map((part) => part.actionId as string),
    ),
  ].reverse();
  let selectedAction: string | undefined;
  let accepted = new Set<string>();
  if (direction === "redo") {
    // A skipped residual stays on its own action. Fully consumed actions expose the previous one.
    for (const action of undoActions) {
      const consumed = new Set(
        all
          .filter(
            (part) =>
              part.kind === "redo" && part.consumes.includes(action) && eligiblePlacement(part),
          )
          .flatMap((part) => part.targets.map(partKey)),
      );
      const remaining = new Set(
        all
          .filter((part) => part.actionId === action)
          .flatMap((part) =>
            part.targets
              .filter((target) => keys.has(partKey(target)) && !consumed.has(partKey(target)))
              .map(partKey),
          ),
      );
      if (remaining.size) {
        selectedAction = action;
        accepted = remaining;
        break;
      }
    }
  }
  return documents.map((document) => {
    const targets = document.history.filter(
      (part) => targetsTurn(part, query) && (direction === "undo" || accepted.has(partKey(part))),
    );
    const rolledBack = (part: StoredInversePart) =>
      document.history.some(
        (entry) =>
          entry.kind === "rollback" &&
          entry.targets.some((target) => partKey(target) === partKey(part)),
      );
    const placements =
      direction === "undo"
        ? targets.filter((part) => !rolledBack(part))
        : document.history.filter(
            (part) =>
              part.actionId === selectedAction &&
              part.targets.some((target) => accepted.has(partKey(target))),
          );
    const pending = placements.find((part) => part.placement.kind === "pending");
    let branchId = pending?.placement.kind === "pending" ? pending.placement.branchId : null;
    // Pending inverse rows hold roots only where their visible identity differs from live.
    const holds = new Map<string, string>();
    for (const part of document.history) {
      if (part.kind === "write" || part.placement.kind !== "pending") continue;
      const draft = document.drafts.get(part.placement.branchId);
      if (!draft || draft.branch.generation !== part.placement.generation) continue;
      const live = new Map(
        inspectEditRoots(document.live, document.history, part.effect).map((entry) => [
          entry.root,
          entry.identity,
        ]),
      );
      for (const entry of inspectEditRoots(draft.doc, document.history, part.effect)) {
        if (entry.identity !== live.get(entry.root)) holds.set(entry.root, draft.branch.branchId);
      }
    }
    if (!branchId && direction === "undo") {
      // An original draft remains the action's own destination while it holds these roots.
      branchId =
        targets
          .flatMap((part) => (part.origin.kind === "pending" ? [part.origin.branchId] : []))
          .find((id) => [...holds.values()].includes(id)) ?? null;
    }
    const draft = branchId ? document.drafts.get(branchId) : undefined;
    const view = draft?.doc ?? document.live;
    const skips: TurnInverseSkip[] = [];
    const heldDraftIds: string[] = [];
    const selection: InverseSelection[] = [];
    const skip = (part: StoredInversePart, reason: string) =>
      skips.push({
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        reason,
      });
    for (const part of targets.sort((a, b) => (direction === "undo" ? b.id - a.id : a.id - b.id))) {
      if (rolledBack(part)) {
        skip(part, "Rolled back");
        continue;
      }
      if (!eligiblePlacement(part)) {
        skip(part, part.placement.kind === "discarded" ? "discarded" : "No longer reversible");
        continue;
      }
      if (draft?.frozen) {
        skip(part, "This draft is archived");
        continue;
      }
      if (
        part.placement.kind === "pending" &&
        (part.placement.branchId !== branchId ||
          draft?.branch.generation !== part.placement.generation)
      ) {
        skip(part, "This part is in another draft");
        continue;
      }
      const holder = inspectEditRoots(view, document.history, part.effect)
        .map((entry) => holds.get(entry.root))
        .find((id) => id && id !== branchId);
      if (holder) {
        heldDraftIds.push(holder);
        skip(
          part,
          `The draft in ${document.drafts.get(holder)?.name ?? holder} holds a restored copy of this text. Apply or discard that draft first.`,
        );
        continue;
      }
      selection.push({ part, direction: direction === "undo" ? "invert" : "reapply" });
    }
    const computed = computeInverse(view, document.history, selection, {
      actionId,
      allocateClient: allocateDocumentClient,
    });
    for (const classified of computed.skipped) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part)
        skip(
          part,
          classified.reasons.includes("inaccessible ancestor")
            ? "Its paragraph was removed"
            : classified.state === "undone"
              ? "Already undone"
              : "Stayed as you edited it",
        );
    }
    return {
      document,
      branchId,
      computed,
      consumes: selectedAction ? [selectedAction] : [],
      skips,
      heldDraftIds,
    };
  });
}
const countAccepted = (plans: PreparedDocumentInverse[]) =>
  plans.reduce(
    (count, plan) => count + plan.computed.edits.reduce((n, edit) => n + edit.parts.length, 0),
    0,
  );

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    async getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null> {
      const query = { threadId, turnId };
      return store.withLockedDocuments(query, async (documents) => {
        if (!documents.length) return null;
        const redo = prepare(store, documents, query, "redo", randomUUID());
        await store.markBlocking(redo.flatMap((plan) => plan.heldDraftIds));
        if (countAccepted(redo))
          return {
            state: "live-reversed",
            control: "redo",
            skips: redo.flatMap((plan) => plan.skips),
          };
        const undo = prepare(store, documents, query, "undo", randomUUID());
        await store.markBlocking(undo.flatMap((plan) => plan.heldDraftIds));
        if (countAccepted(undo))
          return {
            state: "live-active",
            control: "undo",
            skips: undo.flatMap((plan) => plan.skips),
          };
        return {
          state: "expired",
          control: "view_change",
          skips: undo.flatMap((plan) => plan.skips),
        };
      });
    },
    async reverseTurn(
      query: TurnInverseQuery & {
        direction: "undo" | "redo";
        actor: { type: "user"; userId: string } | { type: "agent" };
      },
    ): Promise<ReversalOutcome> {
      return store.withLockedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, query.direction, randomUUID());
        await store.markBlocking(plans.flatMap((plan) => plan.heldDraftIds));
        const accepted = countAccepted(plans);
        if (accepted)
          await store.commit({
            plans,
            kind: query.direction,
            query,
            userId: query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
          });
        const skips = plans.flatMap((plan) => plan.skips);
        return {
          status: accepted
            ? skips.length
              ? "partial"
              : "reversed"
            : plans.length &&
                plans.every(
                  (plan) =>
                    plan.skips.length &&
                    plan.skips.every((skip) => skip.reason === "This draft is archived"),
                )
              ? "permission_denied"
              : "expired",
          documents: plans.map((plan) => ({
            uri: plan.document.uri,
            status: plan.computed.edits.length
              ? "reversed"
              : plan.skips.length &&
                  plan.skips.every((skip) => skip.reason === "This draft is archived")
                ? "permission_denied"
                : "expired",
          })),
          skips,
          acceptedParts: accepted,
        };
      });
    },
    async rollbackResponse(query: TurnInverseQuery & { responseId: string }): Promise<void> {
      await store.withLockedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, "undo", randomUUID());
        await store.markBlocking(plans.flatMap((plan) => plan.heldDraftIds));
        // The store also marks only this response's remaining pending target rows.
        await store.commit({ plans, kind: "rollback", query });
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
