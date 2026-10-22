/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import {
  type InversePart,
  type InverseSelection,
  prepareEditRoots,
} from "@meridian/agent-edit/integration";
import type { DocumentId, EditOrigin, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type {
  DocumentRemovalRecord,
  ReversalOutcome,
  TurnInverseSkip,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import type * as Y from "yjs";
import type { PartDisposition } from "./draft-disposition.js";
import type { DraftSnapshot } from "./draft-store.js";
import { effectiveActionIndex, isRolledBack, partKey } from "./inverse-actions.js";
import { type InverseStep, simulateInverse } from "./inverse-stream.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";
import {
  isTransitionEntry,
  latestTransition,
  type PlannedTreeInverse,
  planTreeInverse,
  type StoredTreeEntry,
  settlementOf,
  type TransitionEntry,
  type TreeStates,
  treeChangedReason,
  treeKey,
} from "./tree-inverse.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  editScopeId: string | null;
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
  model?: boolean;
  draftId?: string | null;
  documentIds?: DocumentId[];
  /** The path the model named, for a document no visible path holds (a deleted one). */
  path?: string;
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
  /** Its tree entries (moves, deletes, restores, settlements), ordered by `seq`. */
  tree: StoredTreeEntry[];
  /** What each destination holds now, for judging tree entries by state. */
  treeStates: TreeStates;
  drafts: ReadonlyMap<
    string,
    { documentDraft: DraftSnapshot; doc: Y.Doc; name: string; frozen: boolean }
  >;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  draftId: string | null;
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
    /**
     * Steps that couldn't run (a taken location, a missing folder, text in a document whose
     * restore couldn't run); the rest ran. A model inverse refuses whole instead.
     */
    skips: TurnInverseSkip[];
    /** Text parts and tree steps committed, by document. */
    reversed: ReadonlyMap<DocumentId, number>;
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
 * One destination per document, and its ordered steps, for both command and dry run. Each of
 * the turn's original edits is one step, newest first for an undo and oldest first for a redo,
 * judged on what the steps before it leave: a restore lets later text land, a reversed undo
 * puts the edit it undid back on the stack.
 */
function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  kind: "undo" | "redo" | "rollback",
  actionId: string,
): PreparedDocumentInverse[] {
  const direction = kind === "redo" ? "redo" : "undo";
  const turnTree = (document: InverseDocument) =>
    document.tree.filter(
      (row): row is TransitionEntry => isTransitionEntry(row) && targetsTurn(row, query),
    );
  const keys = new Set([
    ...documents.flatMap((document) =>
      document.history.filter((part) => targetsTurn(part, query)).map(partKey),
    ),
    ...documents.flatMap((document) => turnTree(document).map((row) => treeKey(row.editId))),
  ]);
  const all = documents
    .flatMap((document): (StoredInversePart | StoredTreeEntry)[] => [
      ...document.history,
      ...document.tree,
    ])
    .sort((a, b) => a.id - b.id);
  const index = effectiveActionIndex(all, keys);
  const selected = direction === "redo" ? index.actions[0] : undefined;
  const selectedAction = selected?.id;
  const accepted = selected?.targets ?? new Set<string>();
  const consumes = selectedAction ? [selectedAction] : [];
  return documents.map((document) => {
    const targets = document.history.filter(
      (part) => targetsTurn(part, query) && (direction === "undo" || accepted.has(partKey(part))),
    );
    const rolledBack = (part: StoredInversePart) => isRolledBack(document.history, part);
    const destinations =
      direction === "undo"
        ? targets.filter((part) => !rolledBack(part))
        : document.history.filter((part) => part.actionId === selectedAction && !rolledBack(part));
    const disposition = (part: StoredInversePart) =>
      (direction === "redo"
        ? destinations.find((candidate) =>
            candidate.targets.some((target) => partKey(target) === partKey(part)),
          )
        : part
      )?.disposition ?? part.disposition;
    const pending = destinations.find((part) => part.origin.kind === "pending");
    const draftId = pending?.origin.kind === "pending" ? pending.origin.draftId : null;
    const draft = draftId ? document.drafts.get(draftId) : undefined;
    const liveIndex = prepareEditRoots(document.live, document.history);
    const textIndex = draft ? liveIndex.forView(draft.doc) : liveIndex;
    const skips: TurnInverseSkip[] = [];
    const simulation = simulateInverse(document, {
      rolledBack: index.rolledBack,
      identity: {
        threadId: null,
        turnId: null,
        responseId: null,
        editScopeId: null,
        actor: kind === "rollback" ? "system" : "human",
      },
    });
    const skipTree = (row: StoredTreeEntry, reason: string) =>
      skips.push({
        documentId: document.documentId,
        uri: document.uri,
        before: row.tree.shownAt ?? "",
        after: "",
        reason,
      });
    const skip = (part: StoredInversePart, reason: string) =>
      skips.push({
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        reason,
      });
    // The originals in step order: a tree entry, or one edit's targeted text parts.
    const byEdit = new Map<string, StoredInversePart[]>();
    for (const part of targets) byEdit.set(part.editId, [...(byEdit.get(part.editId) ?? []), part]);
    const originals = [
      ...turnTree(document)
        .filter((row) => direction === "undo" || accepted.has(treeKey(row.editId)))
        .map((row) => ({ at: row.id, row, parts: [] as StoredInversePart[] })),
      ...[...byEdit.values()].map((parts) => ({
        at: Math.max(...parts.map((part) => part.id)),
        row: undefined,
        parts: parts.sort((a, b) => (direction === "undo" ? b.id - a.id : a.id - b.id)),
      })),
    ].sort((a, b) => (direction === "undo" ? b.at - a.at : a.at - b.at));
    const order: (
      | { kind: "tree"; planned: PlannedTreeInverse; at: number }
      | { kind: "text"; editId: string; at: number }
    )[] = [];
    const selection: InverseSelection[] = [];
    for (const { at, row, parts } of originals) {
      if (row) {
        if (simulation.rolledBack.has(treeKey(row.editId))) {
          skipTree(row, "Rolled back");
          continue;
        }
        const settled = settlementOf(row, document.tree);
        if (settled) {
          skipTree(row, settled === "applied" ? "Applied to the manuscript" : "discarded");
          continue;
        }
        const latest = latestTransition(row, simulation.tree, simulation.rolledBack);
        if (latest.stands !== (direction === "undo")) {
          skipTree(row, direction === "undo" ? "Already undone" : "Already redone");
          continue;
        }
        const planned = planTreeInverse(
          row,
          direction === "undo" ? "invert" : "reapply",
          latest.row,
          simulation.states,
          simulation.nextStep(),
        );
        if (!planned) {
          skipTree(row, `It was ${treeChangedReason(simulation.states, row.tree.destination)}`);
          continue;
        }
        simulation.recordTree(planned, { kind, actionId, consumes });
        order.push({ kind: "tree", planned, at });
        continue;
      }
      let chosen = 0;
      for (const part of parts) {
        if (rolledBack(part)) {
          skip(part, "Rolled back");
          continue;
        }
        // Parts in an active draft that outlived a live delete invert there (D79); parts that
        // landed live meet the removal unless an earlier step restores the document, and a
        // draft-text inverse never restores live.
        if (!draft && simulation.liveRemoved()) {
          skip(
            part,
            `This file was ${document.removal?.reason === "discarded" ? "discarded" : "deleted"}`,
          );
          continue;
        }
        if (disposition(part) === "applied") {
          skip(part, "Applied to the manuscript");
          continue;
        }
        if (draft?.frozen) {
          skip(part, "This draft is archived");
          continue;
        }
        const originDraftId = part.origin.kind === "pending" ? part.origin.draftId : null;
        if (originDraftId !== draftId || (originDraftId && !draft)) {
          skip(part, originDraftId === draftId ? "discarded" : "This part is in another draft");
          continue;
        }
        selection.push({ part, direction: direction === "undo" ? "invert" : "reapply" });
        chosen++;
      }
      if (chosen && parts[0]) order.push({ kind: "text", editId: parts[0].editId, at });
    }
    // Text never moves or deletes a document, so its parts compute as one selection in step
    // order; review membership does not decide inverse eligibility, including rollback.
    const computed = textIndex.compute(selection, {
      actionId,
      allocateClient: allocateDocumentClient,
    });
    for (const classified of computed.skipped) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part)
        skip(
          part,
          disposition(part) === "discarded"
            ? "discarded"
            : classified.reasons.includes("inaccessible ancestor")
              ? "Its paragraph was removed"
              : classified.state === "undone"
                ? "Already undone"
                : "Stayed as you edited it",
        );
    }
    const steps = order.flatMap((step): InverseStep[] => {
      if (step.kind === "tree") return [{ ...step, actionId }];
      const edit = computed.edits.find((edit) => edit.targetEditId === step.editId);
      return edit ? [{ kind: "text", edit, actionId, at: step.at }] : [];
    });
    return { document, draftId, steps, consumes, skips };
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
    (count, plan) =>
      count +
      plan.steps.reduce((n, step) => n + (step.kind === "tree" ? 1 : step.edit.parts.length), 0),
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
          : { skips: [], reversed: new Map<DocumentId, number>() };
        const accepted = [...committed.reversed.values()].reduce((n, count) => n + count, 0);
        const skips = [...plans.flatMap((plan) => plan.skips), ...committed.skips];
        const reversedHere = (plan: PreparedDocumentInverse) =>
          (committed.reversed.get(plan.document.documentId) ?? 0) > 0;
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
            ...(reversedHere(plan)
              ? {
                  destination: plan.draftId
                    ? { kind: "draft" as const, draftId: plan.draftId }
                    : { kind: "live" as const },
                }
              : {}),
            status: reversedHere(plan)
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
