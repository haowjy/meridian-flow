/** Writer receipt and failed-response policies over immutable forward-inverse parts. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { ChangeRead, StoredDelta } from "@meridian/agent-edit/content-merge";
import { readBlocks } from "@meridian/agent-edit/diff";
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
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { Learned } from "../../../shared/tree-owners.js";
import type { Principal } from "../../file-policy/index.js";
import { draftBlocks, draftSchema, isPending, takeBack } from "./draft-changes.js";
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
  /** The changes of the part an Apply in force took, by index in its delta, with the Apply's command. */
  appliedChanges?: ReadonlyMap<number, string>;
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
    /** The cuts around the one draft write a lone document's content step committed. */
    cut?: { before: Uint8Array; after: Uint8Array };
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
 * The chip and the press plan the same way, so the card offers Undo exactly when a press takes
 * something back.
 */
async function prepare(
  store: TurnInverseStore,
  documents: InverseDocument[],
  query: TurnInverseQuery,
  actionId: string,
): Promise<{ plans: PreparedDocumentInverse[]; undoneByWriter: boolean }> {
  let undoneByWriter = false;
  const planOf = async (document: InverseDocument): Promise<PreparedDocumentInverse> => {
    // The server answers its other requests between documents.
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
    const steps: InverseStep[] = [];
    // The text each step is judged on is what the steps before it leave, as its commit will find it.
    let manuscript: readonly PMNode[] = originals.length
      ? readBlocks(document.live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema)
      : [];
    const drafted = new Map<string, { base: readonly PMNode[]; text: readonly PMNode[] }>();
    for (const { at, parts } of originals) {
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
      const { destination, actionKind } = planned;
      const selection = planned.selection as StoredInversePart[];
      if (destination.kind === "draft" && destination.state === "active") {
        // An open draft's proposed changes are taken out as content: a change that stands and sits
        // in a pending change. The changes an Apply took go out of Live, and out of the draft where
        // they stand there, when they stand in Live and taking them out adds no pending change.
        const draft =
          drafted.get(destination.draftId) ??
          draftBlocks(document.drafts.get(destination.draftId)?.doc);
        const back = takeBack(
          manuscript,
          draft,
          selection.flatMap((part) =>
            part.appliedChanges?.size
              ? [{ part, delta: part.delta, only: new Set(part.appliedChanges.keys()) }]
              : [],
          ),
        );
        manuscript = back.live;
        drafted.set(destination.draftId, {
          base: back.base ?? draft.base,
          text: back.text ?? draft.text,
        });
        const backed = new Set(back.taken.map(({ part }) => part));
        const standing = (part: StoredInversePart) =>
          part.changes?.some((change) => change.state === "stands" && isPending(change)) ?? false;
        for (const part of selection)
          if (!standing(part) && !backed.has(part))
            skip(part, part.appliedChanges?.size ? "applied" : "edited_since");
        const proposed = selection.filter(standing);
        if (proposed.length)
          steps.push({ kind: "content", parts: proposed, destination, actionId, actionKind, at });
        if (backed.size)
          steps.push({
            kind: "manuscript",
            parts: back.taken.map(({ part, only }) => ({ part, only })),
            destination,
            actionId,
            actionKind,
            at,
          });
        continue;
      }
      const back = takeBack(
        manuscript,
        null,
        selection.map((part) => ({ part, delta: part.delta })),
      );
      manuscript = back.live;
      const backed = new Set(back.taken.map(({ part }) => part));
      for (const part of selection) if (!backed.has(part)) skip(part, "edited_since");
      if (backed.size)
        steps.push({
          kind: "manuscript",
          parts: back.taken.map(({ part }) => ({ part })),
          destination,
          actionId,
          actionKind,
          at,
        });
    }
    steps.sort((a, b) => b.at - a.at);
    return { document, steps, skips };
  };
  const plans: PreparedDocumentInverse[] = [];
  for (const document of documents) plans.push(await planOf(document));
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
    // An applied change an Undo took out of the manuscript is out, whatever the Apply still says.
    const took = effectiveActionIndex(document.history, new Set(drafted.map(partKey))).byPart;
    states[document.documentId] = drafted.some((part) => part.waiting)
      ? "pending"
      : drafted.some((part) => part.disposition === "applied" && !took.has(partKey(part)))
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
        const treeStates = await store.treeDraftStates(query);
        if (
          !documents.length &&
          !tree.acting &&
          !tree.taken &&
          !tree.stayed.length &&
          Object.keys(treeStates).length === 0
        )
          return null;
        const drafts = draftStates(documents, query);
        const trees = Object.keys(treeStates).length ? treeStates : undefined;
        const { plans: undo, undoneByWriter } = await prepare(
          store,
          documents,
          query,
          randomUUID(),
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
