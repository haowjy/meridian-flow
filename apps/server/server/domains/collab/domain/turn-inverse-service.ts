/** Writer receipt and failed-response policies over the stored edit parts. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import { readBlocks } from "@meridian/agent-edit/diff";
import {
  type CapturedPart,
  type EditKind,
  type EditTarget,
  editHandle,
  fragmentOf,
} from "@meridian/agent-edit/integration";
import type { DocumentId, EditOrigin, ThreadId, TurnId, UserId } from "@meridian/contracts";
import type {
  DocumentRemovalRecord,
  DocumentReversalResult,
  ReversalOutcome,
  TurnDraftState,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import type { Node as PMNode } from "prosemirror-model";
import type * as Y from "yjs";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { Learned } from "../../../shared/tree-owners.js";
import type { Principal } from "../../file-policy/index.js";
import type { InverseDestination, InverseStep } from "./inverse-stream.js";
import { inverseSchema, takeBack } from "./inverse-text.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";
import { createCapturedReversalPlanner } from "./model-reversal-planner.js";

/** A stored edit part without its update bytes: `describePart` reads those for the few it shows. */
export type StoredInversePart = Omit<CapturedPart, "update"> & {
  id: number;
  editId: string;
  ordinal: number;
  kind: EditKind;
  actionId?: string | null;
  targets: EditTarget[];
  documentId: DocumentId;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  responseId: string | null;
  toolCallId: string | null;
  actor: "agent" | "human" | "system";
  wId: number | null;
  origin: EditOrigin;
  /** The edit's recorded delta (an AI write only); what its changes are read from. */
  delta: StoredDelta | null;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ResponseAuthorship;
  toolCallId?: string;
  model?: boolean;
  /** The documents to reverse; the turn's every document when absent (a model's undo names its own). */
  documentIds?: DocumentId[];
  /** The path the model named, for a document no visible path holds (a deleted one). */
  path?: string;
  /** Caller identity for destination admission; the incoming content grant never routes it. */
  principal?: Principal;
  /**
   * Documents the caller writes after the inverse, in the same transaction: a commit takes their
   * keys with its own, in one ID order after the list keys.
   */
  alsoLock?: readonly DocumentId[];
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
  /** A scratch copy of Live, made once while this capture describes history. */
  excerptView: Y.Doc | null;
  /** Where every step of this document writes, as the capture found it. */
  destination: InverseDestination;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  /** The document's steps, in the order they plan and run. */
  steps: InverseStep[];
};
export interface TurnInverseStore {
  /**
   * `run` plans on a lock-free capture and commits through `commit`, whose steps resolve
   * against the committed text under their locks.
   */
  withCapturedDocuments<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T>;
  /**
   * The Works and lineages a card reversal's commit locks, as `commit` would find them: the
   * reply's tree receipts and the grants of every document it writes.
   * Read with no lock, for the caller to lock them first and declare them in the query.
   * Throws `TreeOwnersMoved` when the documents move under the read.
   */
  ownersOf(query: TurnInverseQuery, userId: UserId | undefined): Promise<OwnerLocks>;
  /**
   * How many of the reply's tree receipts the card's Undo would take back (`acting`), and how
   * many are already taken back (`taken`: by an earlier card Undo, or their opposite stands).
   */
  treeSteps(query: TurnInverseQuery): Promise<{ acting: number; taken: number }>;
  /** What became of each node's tree change the reply drafted, by node id. */
  treeDraftStates(query: TurnInverseQuery): Promise<Record<string, TurnDraftState>>;
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
    /** Parts each step of `sequence` took, in order: a step the committed text left nothing for took none. */
    taken: number[];
    updates: Uint8Array[];
    /** Tree receipts of the reply that stand taken back after the command (a card's, never the model's). */
    treeReversed: number;
    /** Text parts committed, by document. */
    reversed: ReadonlyMap<DocumentId, number>;
    /** Live around a lone document's model Undo, for the model's echo. */
    cut?: { before: Uint8Array; after: Uint8Array };
  }>;
  describePart(
    document: InverseDocument,
    part: StoredInversePart,
  ): Promise<{ before: string; after: string }>;
}
type TurnRow = Pick<StoredInversePart, "kind" | "threadId" | "turnId">;
const targetsTurn = (part: TurnRow, query: TurnInverseQuery) =>
  (part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId;

/**
 * Each document's ordered steps, for both command and chip. Each of the turn's original edits is
 * one step, newest first, judged on what the steps before it leave. A part an Undo already took
 * out (the planner's `takenBy`) is neither a step nor a skip: the card's own Undo is done with
 * it, and the model's undo in the same chat is part of what the chat did. `undoneByWriter` says
 * the card's Undo was among them. The chip and the press plan the same way, so the card offers
 * Undo exactly when a press takes something back.
 */
async function prepare(
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
        return false;
      }
      return !document.createdInTurn;
    });
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
      ? readBlocks(fragmentOf(document.live), inverseSchema)
      : [];
    for (const { at, parts } of originals) {
      const entry = {
        id: parts[0]?.editId ?? "",
        handle: parts[0]?.wId === null ? "" : editHandle(parts[0]?.wId ?? 0),
        parts,
      };
      const planned = entryPlanner.turnTextPlan(entry, query);
      if (!planned) continue;
      const back = takeBack(manuscript, planned.selection);
      manuscript = back.live;
      if (back.taken.length)
        steps.push({
          parts: back.taken,
          destination: planned.destination,
          actionId,
          actionKind: planned.actionKind,
          at,
        });
    }
    steps.sort((a, b) => b.at - a.at);
    return { document, steps };
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
        if (!documents.length && !tree.acting && !tree.taken && !Object.keys(treeStates).length)
          return null;
        const drafts = Object.keys(treeStates).length ? treeStates : undefined;
        const { plans: undo, undoneByWriter } = await prepare(documents, query, randomUUID());
        if (hasSteps(undo) || tree.acting) return { control: "undo", drafts };
        return {
          control: "view_change",
          drafts,
          ...(tree.taken || undoneByWriter ? { undone: true as const } : {}),
        };
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
        const { plans, undoneByWriter } = await prepare(documents, query, randomUUID());
        const tree = await store.treeSteps(query);
        const treeSteps = tree.acting + tree.taken;
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
            : { treeReversed: 0, reversed: new Map<DocumentId, number>() };
        const accepted =
          committed.treeReversed + [...committed.reversed.values()].reduce((n, m) => n + m, 0);
        // Text an earlier card Undo took out is taken back too: this Undo has nothing left to do.
        return {
          status: accepted || undoneByWriter ? "reversed" : "expired",
          // One row per document whose text the steps reversed; a document with no text to
          // reverse (it left, or comes back, with its node) has none.
          documents: plans.flatMap((plan): DocumentReversalResult[] =>
            (committed.reversed.get(plan.document.documentId) ?? 0) > 0
              ? [
                  {
                    documentId: plan.document.documentId,
                    uri: plan.document.uri,
                    destination: { kind: "live" as const },
                    status: "reversed" as const,
                  },
                ]
              : [],
          ),
        };
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
