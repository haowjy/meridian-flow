/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import {
  editHandle,
  type InversePart,
  type InverseSelection,
} from "@meridian/agent-edit/integration";
import type {
  BranchId,
  DocumentId,
  EditOrigin,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type {
  DocumentRemovalRecord,
  DocumentReversalResult,
  ReversalOutcome,
  TurnInverseSkip,
  TurnInverseSkipCause,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import type { Principal } from "../../file-policy/index.js";
import type { PartDisposition } from "./draft-disposition.js";
import type { DraftSnapshot } from "./draft-store.js";
import { effectiveActionIndex, partKey } from "./inverse-actions.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import type { InverseStep } from "./inverse-stream.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";
import { createCapturedReversalPlanner } from "./model-reversal-planner.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  editScopeId: string | null;
  toolCallId: string | null;
  consumes: string[];
  actor: "agent" | "human" | "system";
  wId: number | null;
  origin: EditOrigin;
  disposition: PartDisposition;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ModelResponseIdentity;
  toolCallId?: string;
  model?: boolean;
  draftId?: string | null;
  documentIds?: DocumentId[];
  /** The path the model named, for a document no visible path holds (a deleted one). */
  path?: string;
  /** Caller identity for destination admission; the incoming content grant never routes it. */
  principal?: Principal;
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  live: Y.Doc;
  /** The live room `live` was captured from, by its authority; null when it has none yet. */
  liveRoom: string | null;
  /** Removed documents are skipped with the record, never planned against. */
  removal: DocumentRemovalRecord | null;
  history: StoredInversePart[];
  drafts: ReadonlyMap<
    string,
    { documentDraft: DraftSnapshot; doc: Y.Doc; name: string; frozen: boolean }
  >;
  /** Per-source scratch views reused while this capture describes history and skip excerpts. */
  excerptViews: Map<Y.Doc, Y.Doc>;
  /** The sole captured destination resolution used by planning and presentation. */
  destinationOf(origin: EditOrigin): InverseDestination;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  /** The document's steps, in the order they plan and run. */
  steps: InverseStep[];
  consumes: string[];
  skips: TurnInverseSkip[];
};
export interface TurnInverseStore {
  /**
   * The inverse's attempts: `run` plans on a lock-free capture and commits through `commit`;
   * a commit that finds the capture moved reruns `run` on a new capture. After the last
   * attempt `run` sees one more capture on which `commit` throws `ReversalConflictError`.
   */
  withCapturedDocuments<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T>;
  /** Runs `sequence`, every plan's steps in one order, inside one commit scope. */
  commit(input: {
    plans: PreparedDocumentInverse[];
    sequence: { plan: PreparedDocumentInverse; step: InverseStep }[];
    kind: "undo" | "redo" | "revert" | "rollback";
    userId?: UserId;
    query: TurnInverseQuery;
  }): Promise<{
    handles: string[];
    updates: Uint8Array[];
    /** Steps that couldn't run; the rest ran. A model inverse refuses whole instead. */
    skips: TurnInverseSkip[];
    /** Text parts committed, by document and then by where they landed: the branch whose draft took them, null for live. */
    reversed: ReadonlyMap<DocumentId, ReadonlyMap<BranchId | null, number>>;
    /** The destinations that actually committed. */
    outcomes: readonly {
      documentId: DocumentId;
      branchId: BranchId | null;
      draftId: string | null;
    }[];
  }>;
  describePart(
    document: InverseDocument,
    part: StoredInversePart,
  ): { before: string; after: string };
}
type TurnRow = Pick<StoredInversePart, "actor" | "kind" | "threadId" | "turnId" | "editScopeId">;
const targetsTurn = (part: TurnRow, query: TurnInverseQuery) =>
  (query.responseIdentity
    ? part.actor === "agent" && part.kind !== "rollback"
    : part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  (!query.responseIdentity || part.editScopeId === query.responseIdentity.editScopeId);

/**
 * Each document's ordered steps, for both command and dry run; each step lands where its
 * original did, live or in its draft. Each of the turn's original edits is one step, newest
 * first for an undo and oldest first for a redo, judged on what the steps before it leave: a
 * reversed undo puts the edit it undid back on the stack.
 */
function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  kind: "undo" | "redo" | "rollback",
  actionId: string,
): PreparedDocumentInverse[] {
  const direction = kind === "redo" ? "redo" : "undo";
  const keys = new Set(
    documents.flatMap((document) =>
      document.history.filter((part) => targetsTurn(part, query)).map(partKey),
    ),
  );
  const all = documents.flatMap((document) => document.history).sort((a, b) => a.id - b.id);
  const index = effectiveActionIndex(all, keys);
  const selected = direction === "redo" ? index.actions[0] : undefined;
  const selectedAction = selected?.id;
  const accepted = selected?.targets ?? new Set<string>();
  const consumes = selectedAction ? [selectedAction] : [];
  return documents.map((document) => {
    const targets = document.history.filter(
      (part) => targetsTurn(part, query) && (direction !== "redo" || accepted.has(partKey(part))),
    );
    const rolledBack = (part: StoredInversePart) => index.rolledBack.has(partKey(part));
    const reversals =
      direction === "undo"
        ? targets.filter((part) => !rolledBack(part))
        : document.history.filter((part) => part.actionId === selectedAction && !rolledBack(part));
    const skips: TurnInverseSkip[] = [];
    const entryPlanner = createCapturedReversalPlanner(document, query);
    const skip = (part: StoredInversePart, cause: TurnInverseSkipCause) =>
      skips.push({
        kind: "text",
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        cause,
      });
    // The originals in step order: one edit's targeted parts each.
    const byEdit = new Map<string, StoredInversePart[]>();
    for (const part of targets) byEdit.set(part.editId, [...(byEdit.get(part.editId) ?? []), part]);
    const originals = [...byEdit.values()]
      .map((parts) => ({
        at: Math.max(...parts.map((part) => part.id)),
        parts: parts.sort((a, b) => (direction === "undo" ? b.id - a.id : a.id - b.id)),
      }))
      .sort((a, b) => (direction === "undo" ? b.at - a.at : a.at - b.at));
    const order: {
      editId: string;
      destination: InverseDestination;
      actionKind: "undo" | "redo" | "revert" | "rollback";
      at: number;
    }[] = [];
    const selection = new Map<InverseDestination, InverseSelection[]>();
    for (const { at, parts } of originals) {
      let chosen = 0;
      const inverseParts =
        direction === "redo"
          ? reversals.filter((inverse) =>
              parts.some((part) =>
                inverse.targets.some((target) => partKey(target) === partKey(part)),
              ),
            )
          : undefined;
      const entry = {
        id: parts[0]?.editId ?? "",
        handle: parts[0]?.wId === null ? "" : editHandle(parts[0]?.wId ?? 0),
        parts,
      };
      const planned = entryPlanner.turnTextPlan(entry, direction, kind, query, inverseParts);
      if ("causes" in planned) {
        for (const [i, part] of parts.entries())
          skip(part, planned.causes[i] as TurnInverseSkipCause);
        continue;
      }
      for (const { part, direction: partDirection } of planned.selection) {
        const selectedPart = part as StoredInversePart;
        if (rolledBack(selectedPart)) {
          skip(selectedPart, "rolled_back");
          continue;
        }
        selection.set(planned.destination, [
          ...(selection.get(planned.destination) ?? []),
          { part: selectedPart, direction: partDirection },
        ]);
        chosen++;
      }
      if (chosen && parts[0])
        order.push({
          editId: parts[0].editId,
          destination: planned.destination,
          actionKind: planned.actionKind as "undo" | "redo" | "revert" | "rollback",
          at,
        });
    }
    // Each destination's parts compute as one selection in step order over that destination's
    // view; one edit lands in one destination. Review membership does not decide inverse
    // eligibility, including rollback.
    const computed = new Map<InverseDestination, ReturnType<typeof entryPlanner.compute>>(
      [...selection].map(([destination, parts]) => {
        return [destination, entryPlanner.compute(destination, parts, actionId)];
      }),
    );
    const classifiedKeys = new Set(
      [...computed.values()].flatMap((result) =>
        result.skipped.map((classified) => partKey(classified.part)),
      ),
    );
    for (const classified of [...computed.values()].flatMap((result) => result.skipped)) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part) skip(part, entryPlanner.turnSkipCause(part, direction, reversals, classified));
    }
    const emittedEditIds = new Set(
      [...computed.values()].flatMap((result) => result.edits.map((edit) => edit.targetEditId)),
    );
    for (const selected of [...selection.values()].flat()) {
      const key = partKey(selected.part);
      const target = targets.find((part) => partKey(part) === key);
      if (target && !classifiedKeys.has(key) && !emittedEditIds.has(selected.part.editId))
        skip(target, entryPlanner.turnSkipCause(target, direction, reversals, null));
    }
    const steps = order.flatMap((step): InverseStep[] => {
      const edit = computed
        .get(step.destination)
        ?.edits.find((edit) => edit.targetEditId === step.editId);
      return edit
        ? [
            {
              edit,
              destination: step.destination,
              actionId,
              actionKind: step.actionKind,
              at: step.at,
            },
          ]
        : [];
    });
    return { document, steps, consumes, skips };
  });
}

/**
 * Every document's steps as one sequence for the commit: newest original first for an undo,
 * oldest first for a redo, so a renumber across documents never meets a location it vacated
 * later. Each document's own steps already run in that order.
 */
function inSequence(plans: readonly PreparedDocumentInverse[], direction: "undo" | "redo") {
  return plans
    .flatMap((plan) => plan.steps.map((step) => ({ plan, step })))
    .sort((a, b) => (direction === "undo" ? b.step.at - a.step.at : a.step.at - b.step.at));
}
const countAccepted = (plans: PreparedDocumentInverse[]) =>
  plans.reduce(
    (count, plan) => count + plan.steps.reduce((n, step) => n + step.edit.parts.length, 0),
    0,
  );

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    ...createModelInversePolicy(store),
    async getTurnReceiptChip(threadId: ThreadId, turnId: TurnId): Promise<TurnReceiptChip | null> {
      const query = { threadId, turnId };
      return store.withCapturedDocuments(query, async (documents) => {
        if (!documents.length) return null;
        const redo = prepare(store, documents, query, "redo", randomUUID());
        if (countAccepted(redo))
          return {
            state: "live-reversed",
            control: "redo",
            skips: redo.flatMap((plan) => plan.skips),
          };
        const undo = prepare(store, documents, query, "undo", randomUUID());
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
      return store.withCapturedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, query.direction, randomUUID());
        const committed = countAccepted(plans)
          ? await store.commit({
              plans,
              sequence: inSequence(plans, query.direction),
              kind: query.direction,
              query,
              userId: query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
            })
          : {
              skips: [],
              reversed: new Map<DocumentId, ReadonlyMap<BranchId | null, number>>(),
            };
        const reversedAt = (plan: PreparedDocumentInverse) =>
          [...(committed.reversed.get(plan.document.documentId) ?? [])].flatMap(([branchId, n]) =>
            n > 0 ? [branchId] : [],
          );
        const accepted = [...committed.reversed.values()].reduce(
          (n, byDestination) => [...byDestination.values()].reduce((m, count) => m + count, n),
          0,
        );
        const skips = [...plans.flatMap((plan) => plan.skips), ...committed.skips];
        return {
          status: accepted
            ? skips.length
              ? "partial"
              : "reversed"
            : plans.length &&
                plans.every(
                  (plan) =>
                    plan.skips.length &&
                    plan.skips.every((skip) => skip.cause === "draft_archived"),
                )
              ? "permission_denied"
              : "expired",
          // One row per destination a document's steps reversed in, or one for its refusal.
          documents: plans.flatMap((plan): DocumentReversalResult[] => {
            const reversed = reversedAt(plan);
            if (reversed.length)
              return reversed.map((branchId) => ({
                documentId: plan.document.documentId,
                uri: plan.document.uri,
                destination: branchId
                  ? { kind: "draft" as const, branchId }
                  : { kind: "live" as const },
                status: "reversed" as const,
              }));
            return [
              {
                documentId: plan.document.documentId,
                uri: plan.document.uri,
                status:
                  plan.skips.length && plan.skips.every((skip) => skip.cause === "draft_archived")
                    ? ("permission_denied" as const)
                    : ("expired" as const),
              },
            ];
          }),
          skips,
          acceptedParts: accepted,
        };
      });
    },
    async rollbackResponse(
      query: TurnInverseQuery & {
        responseIdentity: import("@meridian/contracts").ModelResponseIdentity;
      },
    ): Promise<TurnInverseSkip[]> {
      return store.withCapturedDocuments(query, async (documents) => {
        const plans = prepare(store, documents, query, "rollback", randomUUID());
        // The store also marks only this response's remaining pending target rows. A step that
        // can't run is reported and the rest still run.
        const { skips } = await store.commit({
          plans,
          sequence: inSequence(plans, "undo"),
          kind: "rollback",
          query,
        });
        return [...plans.flatMap((plan) => plan.skips), ...skips];
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
