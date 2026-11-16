/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { editHandle, type InversePart } from "@meridian/agent-edit/integration";
import type {
  BranchId,
  DocumentId,
  EditOrigin,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type {
  DocumentRemovalRecord,
  DocumentReversalResult,
  ReversalOutcome,
  TurnInverseSkip,
  TurnInverseSkipCause,
  TurnReceiptChip,
  TurnTreeState,
} from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { Learned } from "../../../shared/tree-owners.js";
import type { Principal } from "../../file-policy/index.js";
import type { PartDisposition } from "./draft-disposition.js";
import type { DraftSnapshot } from "./draft-store.js";
import { partKey } from "./inverse-actions.js";
import type { InverseDestination } from "./inverse-draft-destination.js";
import type { InverseStep } from "./inverse-stream.js";
import { INVERSE_WORKERS } from "./inverse-worker.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";
import { createCapturedReversalPlanner } from "./model-reversal-planner.js";

export type StoredInversePart = InversePart & {
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  toolCallId: string | null;
  actor: "agent" | "human" | "system";
  wId: number | null;
  origin: EditOrigin;
  disposition: PartDisposition;
  /** A change waits in an open draft at this part's text, or the writer typed over it (read from the capture; the stored `has_effect` lags a Discard). */
  waiting?: boolean;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ResponseAuthorship;
  toolCallId?: string;
  model?: boolean;
  draftId?: string | null;
  documentIds?: DocumentId[];
  /** The path the model named, for a document no visible path holds (a deleted one). */
  path?: string;
  /** Caller identity for destination admission; the incoming content grant never routes it. */
  principal?: Principal;
  /**
   * The owners the caller already locked (`ownersOf`): a commit that would lock any other
   * throws `TreeOwnersMoved` before taking a lock.
   */
  declared?: OwnerLocks;
  /** What the caller's earlier attempts found they needed: sources whose owners to lock and judge. */
  learned?: Learned;
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  live: Y.Doc;
  /** The live room `live` was captured from, by its authority; null when it has none yet. */
  liveRoom: string | null;
  /** Removed documents are skipped with the record, never planned against. */
  removal: DocumentRemovalRecord | null;
  /** The card's Undo deletes this created document, leaving its text intact. */
  createdInTurn: boolean;
  history: StoredInversePart[];
  drafts: ReadonlyMap<
    string,
    {
      documentDraft: DraftSnapshot;
      doc: Y.Doc;
      name: string;
      closed: ClosedOwnerWhy | null;
      /** The base text each waiting change in the draft removes, read from the capture. */
      waitingRemoved: readonly string[];
    }
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
  /**
   * The Works and lineages a card reversal's commit locks, as `commit` would find them: the
   * documents' drafts, the reply's tree receipts and the grants of every document it writes.
   * Read with no lock, for the caller to lock them first and declare them in the query.
   * Throws `TreeOwnersMoved` when the documents move under the read.
   */
  ownersOf(query: TurnInverseQuery, userId: UserId | undefined): Promise<OwnerLocks>;
  /**
   * The reply's tree receipts by what the card's Undo does with each: those it would take back
   * (`acting`), those already taken back (`taken`: by an earlier card Undo, or their opposite
   * stands), and those that stay, with why (`stayed`).
   */
  treeSteps(
    query: TurnInverseQuery,
  ): Promise<{ acting: number; taken: number; stayed: TurnInverseSkip[] }>;
  /** What became of each node's tree change the reply drafted, by node id (`TurnReceiptChip.trees`). */
  treeDraftStates(query: TurnInverseQuery): Promise<Record<string, TurnTreeState>>;
  /** A document's stored edit parts, in order: all the model's Undo stack is chosen from. */
  readHistory(documentId: DocumentId): Promise<StoredInversePart[]>;
  /** Runs `sequence`, every plan's steps in one order, inside one commit scope. */
  commit(input: {
    plans: PreparedDocumentInverse[];
    sequence: { plan: PreparedDocumentInverse; step: InverseStep }[];
    kind: "undo" | "revert";
    userId?: UserId;
    query: TurnInverseQuery;
  }): Promise<{
    handles: string[];
    updates: Uint8Array[];
    /** Steps that couldn't run; the rest ran. A model inverse refuses whole instead. */
    skips: TurnInverseSkip[];
    /** Tree receipts of the reply that stand taken back after the command (a card's, never the model's). */
    treeReversed: number;
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
type TurnRow = Pick<StoredInversePart, "kind" | "threadId" | "turnId">;
const targetsTurn = (part: TurnRow, query: TurnInverseQuery) =>
  (part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId;

/**
 * Each document's ordered steps, for both command and chip; each step lands where its original
 * did, live or in its draft. Each of the turn's original edits is one step, newest first, judged
 * on what the steps before it leave. A part an Undo already took out (the planner's `takenBy`)
 * is neither a step nor a skip: the card's own Undo is done with it, and the model's undo in the
 * same chat is part of what the chat did. `undoneByWriter` says the card's Undo was among them.
 * A `preview` plan has the steps and skips of the real one, but its steps carry no parts: the
 * chip needs the answer, not the Undo.
 */
async function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  actionId: string,
  { preview = false }: { preview?: boolean } = {},
): Promise<{ plans: PreparedDocumentInverse[]; undoneByWriter: boolean }> {
  let undoneByWriter = false;
  const planOf = async (document: InverseDocument): Promise<PreparedDocumentInverse> => {
    // A preview plans in-process, a document's lineage at a time: the server answers its other
    // requests between documents.
    await setImmediate();
    const entryPlanner = createCapturedReversalPlanner(document, query);
    const targets = document.history.filter((part) => {
      if (!targetsTurn(part, query)) return false;
      const takenBy = entryPlanner.takenBy(part);
      if (takenBy) {
        undoneByWriter ||= takenBy.some((action) =>
          action.parts.every((undo) => undo.actor === "human"),
        );
        return false;
      }
      return !document.createdInTurn;
    });
    const skips: TurnInverseSkip[] = [];
    const skip = (part: StoredInversePart, cause: TurnInverseSkipCause) => {
      const { closed } = document.destinationOf(part.origin);
      skips.push({
        kind: "text",
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        cause,
        ...(cause === "returned" && closed ? { why: closed } : {}),
      });
    };
    // The originals in step order: one edit's targeted parts each.
    const byEdit = new Map<string, StoredInversePart[]>();
    for (const part of targets) byEdit.set(part.editId, [...(byEdit.get(part.editId) ?? []), part]);
    const originals = [...byEdit.values()]
      .map((parts) => ({
        at: Math.max(...parts.map((part) => part.id)),
        parts: parts.sort((a, b) => b.id - a.id),
      }))
      .sort((a, b) => b.at - a.at);
    const order: {
      editId: string;
      destination: InverseDestination;
      actionKind: "undo" | "revert";
      at: number;
    }[] = [];
    const selection = new Map<InverseDestination, InversePart[]>();
    for (const { at, parts } of originals) {
      let chosen = 0;
      const entry = {
        id: parts[0]?.editId ?? "",
        handle: parts[0]?.wId === null ? "" : editHandle(parts[0]?.wId ?? 0),
        parts,
      };
      const planned = entryPlanner.turnTextPlan(entry, query);
      if ("causes" in planned) {
        for (const [i, part] of parts.entries())
          skip(part, planned.causes[i] as TurnInverseSkipCause);
        continue;
      }
      for (const part of planned.discarded) skip(part as StoredInversePart, "discarded");
      for (const part of planned.selection) {
        selection.set(planned.destination, [
          ...(selection.get(planned.destination) ?? []),
          part as StoredInversePart,
        ]);
        chosen++;
      }
      if (chosen && parts[0])
        order.push({
          editId: parts[0].editId,
          destination: planned.destination,
          actionKind: planned.actionKind,
          at,
        });
    }
    // Each destination's parts compute as one selection in step order over that destination's
    // view; one edit lands in one destination. Review membership does not decide inverse
    // eligibility.
    const computed = new Map(
      await Promise.all(
        [...selection].map(
          async ([destination, parts]) =>
            [
              destination,
              await entryPlanner.compute(destination, parts, actionId, { preview }),
            ] as const,
        ),
      ),
    );
    const classifiedKeys = new Set(
      [...computed.values()].flatMap((result) =>
        result.skipped.map((classified) => partKey(classified.part)),
      ),
    );
    for (const classified of [...computed.values()].flatMap((result) => result.skipped)) {
      const part = targets.find((target) => partKey(target) === partKey(classified.part));
      if (part) skip(part, entryPlanner.turnSkipCause(part, classified));
    }
    const emittedEditIds = new Set(
      [...computed.values()].flatMap((result) => result.edits.map((edit) => edit.targetEditId)),
    );
    for (const selected of [...selection.values()].flat()) {
      const key = partKey(selected);
      const target = targets.find((part) => partKey(part) === key);
      if (target && !classifiedKeys.has(key) && !emittedEditIds.has(selected.editId))
        skip(target, entryPlanner.turnSkipCause(target, null));
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
    return { document, steps, skips };
  };
  // As many documents at once as the worker pool has threads. A planner keeps its lineage until
  // its document is done, so a preview, which builds it here, would hold every document's if
  // they all started at once.
  const plans: PreparedDocumentInverse[] = [];
  let next = 0;
  // One failed document ends every lane, so no more jobs go to the pool for a failed command.
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(INVERSE_WORKERS, documents.length) }, async () => {
      while (next < documents.length && !failed) {
        const at = next++;
        try {
          plans[at] = await planOf(documents[at] as InverseDocument);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return { plans, undoneByWriter };
}

/**
 * Every document's steps as one sequence for the commit, newest original first, so a renumber
 * across documents never meets a location it vacated later. Each document's own steps already
 * run in that order.
 */
function inSequence(plans: readonly PreparedDocumentInverse[]) {
  return plans
    .flatMap((plan) => plan.steps.map((step) => ({ plan, step })))
    .sort((a, b) => b.step.at - a.step.at);
}
const hasSteps = (plans: PreparedDocumentInverse[]) => plans.some((plan) => plan.steps.length > 0);

/**
 * What became of this reply's text in each drafted document: still a draft while a waiting
 * change holds a part of it or the writer typed over it, else applied if any part was, else
 * discarded. Another reply's waiting change in the same draft does not count.
 */
function draftStates(
  documents: readonly InverseDocument[],
  query: TurnInverseQuery,
  describe: TurnInverseStore["describePart"],
): TurnReceiptChip["drafts"] {
  const states: NonNullable<TurnReceiptChip["drafts"]> = {};
  for (const document of documents) {
    const drafted = document.history.filter(
      (part) => targetsTurn(part, query) && part.origin.kind === "pending",
    );
    if (!drafted.length) continue;
    // A part's change is gone from the review when the writer typed over it; it still waits if
    // a waiting change removes the base text the part replaced.
    const retyped = (part: StoredInversePart) => {
      const draft =
        part.origin.kind === "pending" ? document.drafts.get(part.origin.draftId) : null;
      const removed = describe(document, part).before.trim();
      return (
        draft?.documentDraft.status === "active" &&
        removed !== "" &&
        draft.waitingRemoved.some((text) => text.includes(removed))
      );
    };
    states[document.documentId] = drafted.some((part) => part.waiting || retyped(part))
      ? "pending"
      : drafted.some((part) => part.disposition === "applied")
        ? "applied"
        : "discarded";
  }
  return Object.keys(states).length ? states : undefined;
}

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    ...createModelInversePolicy(store),
    async getDocumentAndTreeChip(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<TurnReceiptChip | null> {
      const query = { threadId, turnId };
      return store.withCapturedDocuments(query, async (documents) => {
        // A reply that only changed the tree has no text to capture, and its card still takes it back.
        const tree = await store.treeSteps(query);
        if (!documents.length && !tree.acting && !tree.taken && !tree.stayed.length) return null;
        const drafts = draftStates(documents, query, (document, part) =>
          store.describePart(document, part),
        );
        const treeStates = await store.treeDraftStates(query);
        const trees = Object.keys(treeStates).length ? treeStates : undefined;
        const { plans: undo, undoneByWriter } = await prepare(
          store,
          documents,
          query,
          randomUUID(),
          {
            preview: true,
          },
        );
        // A part an Undo took out has no skip, so the skips are the parts that stay.
        const skips = [...undo.flatMap((plan) => plan.skips), ...tree.stayed];
        if (hasSteps(undo) || tree.acting)
          return { state: "live-active", control: "undo", drafts, trees, skips };
        const state =
          tree.taken || undoneByWriter ? (skips.length ? "partly" : "undone") : "expired";
        return { state, control: "view_change", drafts, trees, skips };
      });
    },
    /** What a card reversal of this query locks, for its caller to hold first (`ownersOf`). */
    reversalOwners(
      query: TurnInverseQuery & { actor: { type: "user"; userId: string } | { type: "agent" } },
    ): Promise<OwnerLocks> {
      return store.ownersOf(
        query,
        query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
      );
    },
    async reverseTurn(
      query: TurnInverseQuery & { actor: { type: "user"; userId: string } | { type: "agent" } },
    ): Promise<ReversalOutcome> {
      return store.withCapturedDocuments(query, async (documents) => {
        const { plans, undoneByWriter } = await prepare(store, documents, query, randomUUID());
        const tree = await store.treeSteps(query);
        const treeSteps = tree.acting + tree.taken + tree.stayed.length;
        if (!query.documentIds && !plans.length && !treeSteps)
          return { status: "nothing_to_undo", documents: [] };
        const committed =
          hasSteps(plans) || treeSteps
            ? await store.commit({
                plans,
                sequence: inSequence(plans),
                kind: "undo",
                query,
                userId: query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
              })
            : {
                skips: [],
                treeReversed: 0,
                reversed: new Map<DocumentId, ReadonlyMap<BranchId | null, number>>(),
              };
        const reversedAt = (plan: PreparedDocumentInverse) =>
          [...(committed.reversed.get(plan.document.documentId) ?? [])].flatMap(([branchId, n]) =>
            n > 0 ? [branchId] : [],
          );
        const accepted =
          committed.treeReversed +
          [...committed.reversed.values()].reduce(
            (n, byDestination) => [...byDestination.values()].reduce((m, count) => m + count, n),
            0,
          );
        const skips = [...plans.flatMap((plan) => plan.skips), ...committed.skips];
        // A reply of tree changes alone, each of which stayed: the skips say why.
        const treeStayed =
          !plans.length && skips.length > 0 && skips.every((skip) => skip.kind === "tree");
        // Text an earlier card Undo took out is taken back too: this Undo has nothing left to do.
        return {
          status:
            accepted || undoneByWriter
              ? skips.length
                ? "partial"
                : "reversed"
              : treeStayed
                ? "not_undone"
                : "expired",
          // One row per destination a document's steps reversed in, or one for its refusal; a
          // document with no text to reverse (it left, or comes back, with its node) has none.
          documents: plans.flatMap((plan): DocumentReversalResult[] => {
            if (!plan.steps.length && !plan.skips.length) return [];
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
                status: "expired" as const,
              },
            ];
          }),
          skips,
          acceptedParts: accepted,
        };
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
