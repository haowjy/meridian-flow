/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import {
  type InversePart,
  type InverseSelection,
  prepareEditRoots,
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
  TreeReversalFault,
  TreeReversalLanding,
  TurnInverseSkip,
  TurnInverseSkipCause,
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
  treeChangedCause,
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
  /** The target branch even when this document has only a move or delete, with no text draft. */
  branchId?: BranchId | null;
  documentIds?: DocumentId[];
  /** The path the model named, for a document no visible path holds (a deleted one). */
  path?: string;
  /**
   * The destinations the writer's card may reverse, each a document live (`branchId` null) or
   * in a branch; an edit that landed anywhere else is left out. Absent: every destination.
   */
  destinations?: readonly InverseDestination[];
};
export type InverseDestination = { documentId: DocumentId; branchId: BranchId | null };
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
  /** The document's steps, in the order they plan and run. */
  steps: InverseStep[];
  consumes: string[];
  skips: TurnInverseSkip[];
};
export type CommittedTreeLanding = TreeReversalLanding & { handle: string };
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
     * Steps that couldn't run (a blocked or missing folder, text in a document whose
     * restore couldn't run); the rest ran. A model inverse refuses whole instead.
     */
    skips: TurnInverseSkip[];
    /** Tree steps whose committed address differs from the recorded destination. */
    landings: CommittedTreeLanding[];
    /**
     * Text parts and tree steps committed, by document and then by where they landed: the
     * branch whose text draft or tree facts took them, null for live.
     */
    reversed: ReadonlyMap<DocumentId, ReadonlyMap<BranchId | null, number>>;
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

/** Whether the query's destinations admit `row`, a text part or tree entry of `document`. */
function admits(
  query: TurnInverseQuery,
  document: InverseDocument,
  row: StoredInversePart | StoredTreeEntry,
): boolean {
  if (!query.destinations) return true;
  let branchId: string | null;
  if ("tree" in row)
    branchId = row.tree.destination.kind === "draft" ? row.tree.destination.branchId : null;
  else if (row.origin.kind !== "pending") branchId = null;
  else {
    const draft = document.drafts.get(row.origin.draftId);
    // A draft the capture didn't find is skipped as discarded, never written.
    if (!draft) return true;
    branchId = draft.documentDraft.branchId;
  }
  return query.destinations.some(
    (destination) =>
      destination.documentId === document.documentId && destination.branchId === branchId,
  );
}

/**
 * Each document's ordered steps, for both command and dry run; each text step lands where its
 * original did, live or in its draft. Each of
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
  const inTurn = (document: InverseDocument, row: StoredInversePart | StoredTreeEntry) =>
    targetsTurn(row, query) && admits(query, document, row);
  const turnTree = (document: InverseDocument) =>
    document.tree.filter(
      (row): row is TransitionEntry => isTransitionEntry(row) && inTurn(document, row),
    );
  const keys = new Set([
    ...documents.flatMap((document) =>
      document.history.filter((part) => inTurn(document, part)).map(partKey),
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
      (part) => inTurn(document, part) && (direction === "undo" || accepted.has(partKey(part))),
    );
    const rolledBack = (part: StoredInversePart) => isRolledBack(document.history, part);
    const reversals =
      direction === "undo"
        ? targets.filter((part) => !rolledBack(part))
        : document.history.filter((part) => part.actionId === selectedAction && !rolledBack(part));
    const disposition = (part: StoredInversePart) =>
      (direction === "redo"
        ? reversals.find((candidate) =>
            candidate.targets.some((target) => partKey(target) === partKey(part)),
          )
        : part
      )?.disposition ?? part.disposition;
    const liveIndex = prepareEditRoots(document.live, document.history);
    const draftOf = (part: StoredInversePart) =>
      part.origin.kind === "pending" ? part.origin.draftId : null;
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
    const skipTree = (row: StoredTreeEntry, cause: TurnInverseSkipCause) =>
      skips.push({
        kind: "tree",
        documentId: document.documentId,
        uri: document.uri,
        at: row.tree.shownAt,
        cause,
      });
    const skip = (part: StoredInversePart, cause: TurnInverseSkipCause) =>
      skips.push({
        kind: "text",
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        cause,
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
      | { kind: "text"; editId: string; draftId: string | null; at: number }
    )[] = [];
    const selection = new Map<string | null, InverseSelection[]>();
    for (const { at, row, parts } of originals) {
      if (row) {
        if (simulation.rolledBack.has(treeKey(row.editId))) {
          skipTree(row, "rolled_back");
          continue;
        }
        const settled = settlementOf(row, document.tree);
        if (settled) {
          skipTree(row, settled === "applied" ? "applied" : "discarded");
          continue;
        }
        const latest = latestTransition(row, simulation.tree, simulation.rolledBack);
        if (latest.stands !== (direction === "undo")) {
          skipTree(row, direction === "undo" ? "already_undone" : "already_redone");
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
          skipTree(row, treeChangedCause(simulation.states, row.tree.destination));
          continue;
        }
        simulation.recordTree(planned, { kind, actionId, consumes });
        order.push({ kind: "tree", planned, at });
        continue;
      }
      let chosen = 0;
      for (const part of parts) {
        if (rolledBack(part)) {
          skip(part, "rolled_back");
          continue;
        }
        const draftId = draftOf(part);
        const draft = draftId ? document.drafts.get(draftId) : undefined;
        // Parts in an active draft that outlived a live delete invert there (D79); parts that
        // landed live meet the removal unless an earlier step restores the document, and a
        // draft-text inverse never restores live.
        if (!draftId && simulation.liveRemoved()) {
          skip(
            part,
            document.removal?.reason === "discarded" ? "document_discarded" : "document_deleted",
          );
          continue;
        }
        if (disposition(part) === "applied") {
          skip(part, "applied");
          continue;
        }
        if (draftId && !draft) {
          skip(part, "discarded");
          continue;
        }
        if (draft?.frozen) {
          skip(part, "draft_archived");
          continue;
        }
        selection.set(draftId, [
          ...(selection.get(draftId) ?? []),
          { part, direction: direction === "undo" ? "invert" : "reapply" },
        ]);
        chosen++;
      }
      if (chosen && parts[0])
        order.push({ kind: "text", editId: parts[0].editId, draftId: draftOf(parts[0]), at });
    }
    // Text never moves or deletes a document, so each destination's parts compute as one
    // selection in step order over that destination's view; one edit lands in one
    // destination. Review membership does not decide inverse eligibility, including rollback.
    const computed = new Map(
      [...selection].map(([draftId, parts]) => {
        const draft = draftId ? document.drafts.get(draftId) : undefined;
        const index = draft ? liveIndex.forView(draft.doc) : liveIndex;
        return [
          draftId,
          index.compute(parts, { actionId, allocateClient: allocateDocumentClient }),
        ];
      }),
    );
    for (const classified of [...computed.values()].flatMap((result) => result.skipped)) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part)
        skip(
          part,
          disposition(part) === "discarded"
            ? "discarded"
            : classified.reasons.includes("inaccessible ancestor")
              ? "paragraph_removed"
              : classified.state === "undone"
                ? "already_undone"
                : "edited_since",
        );
    }
    const steps = order.flatMap((step): InverseStep[] => {
      if (step.kind === "tree") return [{ ...step, actionId }];
      const edit = computed
        .get(step.draftId)
        ?.edits.find((edit) => edit.targetEditId === step.editId);
      return edit ? [{ kind: "text", edit, draftId: step.draftId, actionId, at: step.at }] : [];
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
    (count, plan) =>
      count +
      plan.steps.reduce((n, step) => n + (step.kind === "tree" ? 1 : step.edit.parts.length), 0),
    0,
  );

/**
 * Why a reversal that reversed nothing failed, when a move or delete met its destination
 * unable to take it: a blocked folder path first, then a missing folder, then a document moved
 * or deleted again since. Not a dependency on later edits.
 */
function treeFault(skips: readonly TurnInverseSkip[]): TreeReversalFault | null {
  const causes = new Set(skips.flatMap((skip) => (skip.kind === "tree" ? [skip.cause] : [])));
  if (causes.has("ancestor_taken")) return "ancestor_taken";
  if (causes.has("folder_missing")) return "folder_missing";
  return ["superseded", "deleted_since", "moved_since"].some((cause) =>
    causes.has(cause as TurnInverseSkipCause),
  )
    ? "superseded"
    : null;
}

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
              landings: [],
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
            : (treeFault(skips) ??
              (plans.length &&
              plans.every(
                (plan) =>
                  plan.skips.length && plan.skips.every((skip) => skip.cause === "draft_archived"),
              )
                ? "permission_denied"
                : "expired")),
          // One row per destination a document's steps reversed in, or one for its refusal.
          documents: plans.flatMap((plan): DocumentReversalResult[] => {
            const reversed = reversedAt(plan);
            if (reversed.length)
              return reversed.map((branchId) => ({
                uri: plan.document.uri,
                destination: branchId
                  ? { kind: "draft" as const, branchId }
                  : { kind: "live" as const },
                status: "reversed" as const,
              }));
            return [
              {
                uri: plan.document.uri,
                status:
                  plan.skips.length && plan.skips.every((skip) => skip.cause === "draft_archived")
                    ? ("permission_denied" as const)
                    : (treeFault(
                        skips.filter((skip) => skip.documentId === plan.document.documentId),
                      ) ?? ("expired" as const)),
              },
            ];
          }),
          skips,
          ...(committed.landings.length
            ? {
                landings: committed.landings.map(({ handle: _handle, ...landing }) => landing),
              }
            : {}),
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
