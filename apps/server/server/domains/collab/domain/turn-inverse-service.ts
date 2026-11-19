/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { ChangeRead, StoredDelta } from "@meridian/agent-edit/content-merge";
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
  TurnAppliedCommand,
  TurnInverseSkip,
  TurnInverseSkipCause,
  TurnReceiptChip,
  TurnTreeState,
} from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { Learned } from "../../../shared/tree-owners.js";
import type { Principal } from "../../file-policy/index.js";
import { isPending } from "./draft-changes.js";
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
  /** The edit's recorded delta (an AI write only); what its changes are read from. */
  delta: StoredDelta | null;
  /** What each change of a drafted part is in its draft now, read at the capture. */
  changes?: readonly ChangeRead[];
  /** A change of this part sits in a pending change of its open draft. */
  waiting?: boolean;
  /** The Apply that took an applied part: its Un-Apply takes the part back, not the card's revert. */
  appliedBy?: string;
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
  /**
   * What became of each node's tree change the reply drafted, by node id (`TurnReceiptChip.trees`),
   * and every Apply that took one of each node's changes.
   */
  treeDraftStates(query: TurnInverseQuery): Promise<{
    states: Record<string, TurnTreeState>;
    appliedBy: Record<string, readonly string[]>;
  }>;
  /**
   * Each Apply command's branch, the nodes it landed on, and how many changes it made (text groups
   * and tree moves), read by its id; an id with no stored Apply is absent. `textTakenBack`: it
   * landed text, and an Un-Apply took back every group of it.
   */
  applyCommands(
    commandIds: readonly string[],
  ): Promise<
    Map<
      string,
      { branchId: string; nodes: readonly string[]; changes: number; textTakenBack: boolean }
    >
  >;
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
        // What stands in an open draft is read from the text, not from what an Undo recorded: a
        // part an Undo took stays a target only while a change of it is back in the draft.
        const destination = document.destinationOf(part.origin);
        if (destination.kind !== "draft" || destination.state !== "active" || !part.waiting)
          return false;
      }
      return !document.createdInTurn;
    });
    const skips: TurnInverseSkip[] = [];
    const skip = (part: StoredInversePart, cause: TurnInverseSkipCause) => {
      const { closed, kind } = document.destinationOf(part.origin);
      skips.push({
        kind: "text",
        ...store.describePart(document, part),
        documentId: document.documentId,
        uri: document.uri,
        ...(kind === "draft" ? { drafted: true as const } : {}),
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
    const contentSteps: InverseStep[] = [];
    const order: {
      editId: string;
      destination: InverseDestination;
      actionKind: "undo" | "revert";
      at: number;
    }[] = [];
    const selection = new Map<InverseDestination, InversePart[]>();
    for (const { at, parts: all } of originals) {
      let chosen = 0;
      // A part an Apply took goes back with that Apply's Un-Apply, which the card sends beside.
      const parts = all.filter((part) => {
        if (!part.appliedBy) return true;
        skip(part, "applied");
        return false;
      });
      if (parts.length === 0) continue;
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
      for (const part of planned.discarded) skip(part, "discarded");
      if (planned.destination.kind === "draft" && planned.destination.state === "active") {
        // An open draft's text is taken out as content: a part with a change that stands and sits
        // in a pending change is a step; one with none left was altered since.
        const stands = (part: StoredInversePart) =>
          part.changes?.some((change) => change.state === "stands" && isPending(change)) ?? false;
        for (const part of planned.selection)
          if (!stands(part as StoredInversePart)) skip(part as StoredInversePart, "edited_since");
        const takable = planned.selection.filter((part) => stands(part as StoredInversePart));
        if (takable.length)
          contentSteps.push({
            kind: "content",
            parts: takable as StoredInversePart[],
            destination: planned.destination,
            actionId,
            actionKind: planned.actionKind,
            at,
          });
        continue;
      }
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
    const steps = [
      ...order.flatMap((step): InverseStep[] => {
        const edit = computed
          .get(step.destination)
          ?.edits.find((edit) => edit.targetEditId === step.editId);
        return edit
          ? [
              {
                kind: "kernel" as const,
                edit,
                destination: step.destination,
                actionId,
                actionKind: step.actionKind,
                at: step.at,
              },
            ]
          : [];
      }),
      ...contentSteps,
    ].sort((a, b) => b.at - a.at);
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
 * What became of this reply's text in each drafted document: still a draft while a change of it
 * sits in a pending change (it stands, or the writer altered it), else applied if any part was,
 * else discarded. Another reply's waiting change in the same draft does not count.
 */
function draftStates(
  documents: readonly InverseDocument[],
  query: TurnInverseQuery,
): TurnReceiptChip["drafts"] {
  const states: NonNullable<TurnReceiptChip["drafts"]> = {};
  for (const document of documents) {
    const drafted = document.history.filter(
      (part) => targetsTurn(part, query) && part.origin.kind === "pending",
    );
    if (!drafted.length) continue;
    states[document.documentId] = drafted.some((part) => part.waiting)
      ? "pending"
      : drafted.some((part) => part.disposition === "applied")
        ? "applied"
        : "discarded";
  }
  return Object.keys(states).length ? states : undefined;
}

/**
 * The Applies in force that took the reply's drafted changes, text and tree, each read once by
 * its id. One whose tree half is taken back and whose every text group an Un-Apply took back has
 * nothing left for the card's Undo, though the draft still reads its text applied. A group an
 * Un-Apply left because its words changed since keeps the Apply listed: each press judges it anew. One holds only this reply's
 * changes when every node it landed on is the reply's and no other reply's part it took sits in
 * the reply's documents.
 */
async function appliedCommandsOf(
  store: TurnInverseStore,
  documents: readonly InverseDocument[],
  query: TurnInverseQuery,
  treeAppliedBy: Record<string, readonly string[]>,
): Promise<TurnAppliedCommand[]> {
  const treeInForce = new Set<string>(Object.values(treeAppliedBy).flat());
  const ours = new Set(treeInForce);
  const others = new Set<string>();
  for (const document of documents)
    for (const part of document.history)
      if (part.appliedBy) (targetsTurn(part, query) ? ours : others).add(part.appliedBy);
  if (ours.size === 0) return [];
  const nodes = new Set<string>([
    ...documents.map((document) => document.documentId as string),
    ...Object.keys(treeAppliedBy),
  ]);
  const stored = await store.applyCommands([...ours]);
  return [...ours].flatMap((commandId) => {
    const command = stored.get(commandId);
    if (!command || (command.textTakenBack && !treeInForce.has(commandId))) return [];
    return [
      {
        commandId,
        branchId: command.branchId,
        count: command.changes,
        onlyThisTurn: !others.has(commandId) && command.nodes.every((node) => nodes.has(node)),
      },
    ];
  });
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
        // A reply that only changed the tree has no text to capture, and its card still takes it
        // back: by its own Undo, or by the Un-Apply of each Apply that took one of its changes.
        const tree = await store.treeSteps(query);
        const { states: treeStates, appliedBy: treeAppliedBy } = await store.treeDraftStates(query);
        if (
          !documents.length &&
          !tree.acting &&
          !tree.taken &&
          !tree.stayed.length &&
          Object.keys(treeAppliedBy).length === 0
        )
          return null;
        const drafts = draftStates(documents, query);
        const trees = Object.keys(treeStates).length ? treeStates : undefined;
        const applied = await appliedCommandsOf(store, documents, query, treeAppliedBy);
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
        const withApplied = applied.length ? { applied } : {};
        if (hasSteps(undo) || tree.acting)
          return { state: "live-active", control: "undo", drafts, trees, skips, ...withApplied };
        if (applied.length)
          return { state: "live-active", control: "view_change", drafts, trees, skips, applied };
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
