/** Writer receipt and failed-response policies over the stored edit parts. */
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { StoredDelta } from "@meridian/agent-edit/integration";
import { editHandle } from "@meridian/agent-edit/integration";
import type {
  CommandId,
  DocumentId,
  DraftId,
  EditOrigin,
  LinkView,
  ThreadId,
  TurnId,
  UserId,
} from "@meridian/contracts";
import type { ClosedOwnerWhy } from "@meridian/contracts/commands";
import type {
  DocumentRemovalRecord,
  DocumentReversalResult,
  DocumentRoom,
  ReversalOutcome,
  TurnDraftState,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import type { RoomDocs, StoredEdit } from "@meridian/document-model";
import type { OwnerLocks } from "../../../shared/draft-owner.js";
import type { Learned } from "../../../shared/tree-owners.js";
import type { Principal } from "../../file-policy/index.js";
import type { InverseStep } from "./inverse-stream.js";
import { createModelInversePolicy } from "./model-inverse-policy.js";
import { createReversalPlanner } from "./model-reversal-planner.js";

type EditKind = "write" | "undo" | "revert";
/** A part an undo or revert part takes back. */
export type EditTarget = { editId: string; ordinal: number };

/** A stored edit part, without its update bytes. */
export type StoredInversePart = {
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
  /** The room the part was written in (`origin`'s): Live, or a draft's fork. Its Undo runs there. */
  room: DocumentRoom;
  /** The edit's recorded delta (an AI write only): the card's and the model's list's words. */
  delta: StoredDelta | null;
  /** An AI write as an edit of design §2's Undo rule: what an inverse tests and takes back. */
  edit: StoredEdit | null;
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
  /** Where the model's chat writes the document now; a card's query has none (Live). */
  view?: LinkView;
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
/** A room an inverse's parts were written in, as the capture read it. */
export type CapturedRoom = {
  room: DocumentRoom;
  /** A private copy, freed when the read ends; none on a ledger-only read. */
  docs?: RoomDocs;
  /** Why the room's owner (an archived or deleted Work, or its draft) takes no write, else null. */
  closed: ClosedOwnerWhy | null;
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  /** The room the chat writes the document in now: Live, or a Draft chat's fork. */
  room: DocumentRoom;
  /** Each room the chat's parts were written in, and `room`, by room name: each part goes back in its own. */
  rooms: ReadonlyMap<string, CapturedRoom>;
  /** Removed documents are skipped with the record, never planned against. */
  removal: DocumentRemovalRecord | null;
  /** The card's Undo deletes this created document, leaving its text intact. */
  createdInTurn: boolean;
  history: StoredInversePart[];
  /** Whether `rooms` carry their copies; a ledger-only read has none. */
  copies: boolean;
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  /** The document's steps, newest original first. */
  steps: InverseStep[];
  /** The turn's parts whose history the room cut, which the steps leave as they are. */
  compacted: number;
};
/** One selection over a read of the documents: the steps to commit, in order, and what it says. */
export type InverseSelection<T> = {
  steps: { document: InverseDocument; step: InverseStep }[];
  value: T;
};
/** What an inverse's commit did, beside what its selection said. */
export type InverseCommitted = {
  /** The model's write handle of each step, in order; empty for the writer's. */
  handles: string[];
  /** The batches the steps committed into the room the chat writes in, in order. */
  updates: Uint8Array[];
  /** Tree receipts of the reply that stand taken back after the command (a card's, never the model's). */
  treeReversed: number;
  /** A step took text out of a draft that Live still holds (an Apply put it there). */
  inManuscript: boolean;
};
export interface TurnInverseStore {
  /** `use` reads the documents with private room copies and no lock: what a chip or a list shows. */
  read<T>(query: TurnInverseQuery, use: (documents: InverseDocument[]) => Promise<T>): Promise<T>;
  /**
   * An inverse: `select` runs on a ledger-only read for what it may write, which the command admits
   * and locks; then, under the locks, on the documents read again, where its steps take their
   * parts back on the locked copies, and the command commits them. With no step and no tree
   * change, nothing locks and the ledger read's answer stands (`committed` is null).
   */
  run<T>(
    input: { query: TurnInverseQuery; kind: "undo" | "revert"; userId?: UserId },
    select: (documents: InverseDocument[]) => Promise<InverseSelection<T>>,
  ): Promise<{ value: T; committed: InverseCommitted | null }>;
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
  /**
   * For the turn's restore (its card's `Undo turn`): the drafts where pressing it would change something, and the
   * restore press in force for each draft the turn wrote in.
   */
  restoreStates(
    query: TurnInverseQuery,
  ): Promise<{ offered: DraftId[]; restored: { draft: DraftId; press: CommandId }[] }>;
  /** What became of each node's tree change the reply drafted, by node id. */
  treeDraftStates(
    query: TurnInverseQuery,
    restored: readonly { draft: DraftId; press: CommandId }[],
  ): Promise<Record<string, TurnDraftState>>;
  /** A document's stored edit parts a chat's inverse reads, in order: its Undo stack is chosen from them. */
  readHistory(documentId: DocumentId, threadId: string): Promise<StoredInversePart[]>;
}
type TurnRow = Pick<StoredInversePart, "kind" | "threadId" | "turnId" | "origin">;
/**
 * The card's Undo takes back the turn's Live writes; a write made in a draft is `Undo
 * turn`'s (design §5), so one action, a press with its own Undo, takes a draft's writes back.
 */
const targetsTurn = (part: TurnRow, query: TurnInverseQuery) =>
  (part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  !part.origin.draftId;

/**
 * Each document's ordered steps, for both command and chip. Each of the turn's original edits is
 * one step, newest first, taken back on what the steps before it leave. A part an Undo already
 * took out (the planner's `takenBy`) is neither a step nor a skip: the card's own Undo is done
 * with it, and the model's undo in the same chat is part of what the chat did. `undoneByWriter`
 * says the card's Undo was among them. The chip and the press select the same way, so the card
 * offers Undo exactly when a press takes something back.
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
    const entryPlanner = createReversalPlanner(document, query);
    {
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
      for (const part of targets)
        byEdit.set(part.editId, [...(byEdit.get(part.editId) ?? []), part]);
      const originals = [...byEdit.values()]
        .map((parts) => ({
          at: Math.max(...parts.map((part) => part.id)),
          parts: parts.sort((a, b) => b.id - a.id),
        }))
        .sort((a, b) => b.at - a.at);
      const steps: InverseStep[] = [];
      let compacted = 0;
      for (const { at, parts } of originals) {
        const entry = {
          id: parts[0]?.editId ?? "",
          handle: parts[0]?.wId === null ? "" : editHandle(parts[0]?.wId ?? 0),
          parts,
        };
        const planned = entryPlanner.turnTextPlan(entry, query);
        if (!planned) continue;
        const took = entryPlanner.takeOut(planned.selection);
        compacted += took.compacted;
        if (took.taken.length)
          steps.push({
            parts: took.taken,
            rooms: took.rooms,
            actionId,
            actionKind: planned.actionKind,
            at,
          });
      }
      return { document, steps, compacted };
    }
  };
  const plans: PreparedDocumentInverse[] = [];
  for (const document of documents) plans.push(await planOf(document));
  return { plans, undoneByWriter };
}

/** Every document's steps as one sequence for the commit, newest original first. */
function inSequence(plans: readonly PreparedDocumentInverse[]) {
  return plans
    .flatMap(({ document, steps }) => steps.map((step) => ({ document, step })))
    .sort((a, b) => b.step.at - a.step.at);
}
const hasSteps = (plans: PreparedDocumentInverse[]) => plans.some((plan) => plan.steps.length > 0);
const partsOf = (plan: PreparedDocumentInverse) =>
  plan.steps.reduce((n, step) => n + step.parts.length, 0);

export function createTurnInverseService(store: TurnInverseStore) {
  return {
    ...createModelInversePolicy(store),
    async getDocumentAndTreeChip(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<TurnReceiptChip | null> {
      const query = { threadId, turnId };
      return store.read(query, async (documents) => {
        // A reply that only changed the tree has no text to capture, and its card still takes it back.
        const tree = await store.treeSteps(query);
        const { offered, restored } = await store.restoreStates(query);
        const treeStates = await store.treeDraftStates(query, restored);
        if (!documents.length && !tree.acting && !tree.taken && !Object.keys(treeStates).length)
          return null;
        const drafts = Object.keys(treeStates).length ? treeStates : undefined;
        const restore = {
          ...(offered.length ? { restore: offered } : {}),
          ...(restored.length ? { restored } : {}),
        };
        const { plans: undo, undoneByWriter } = await prepare(documents, query, randomUUID());
        if (hasSteps(undo) || tree.acting) return { control: "undo", drafts, ...restore };
        return {
          control: "view_change",
          drafts,
          ...restore,
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
      const tree = await store.treeSteps(query);
      const treeSteps = tree.acting + tree.taken;
      const actionId = randomUUID();
      const { value, committed } = await store.run(
        {
          query,
          kind: "undo",
          userId: query.actor.type === "user" ? (query.actor.userId as UserId) : undefined,
        },
        async (documents) => {
          const prepared = await prepare(documents, query, actionId);
          return { steps: inSequence(prepared.plans), value: prepared };
        },
      );
      const { plans, undoneByWriter } = value;
      if (!query.documentIds && !plans.length && !treeSteps)
        return { status: "nothing_to_undo", documents: [] };
      const accepted =
        (committed?.treeReversed ?? 0) +
        (committed ? plans.reduce((n, plan) => n + partsOf(plan), 0) : 0);
      // An AI edit whose history the room cut stays as it is (design §2).
      const compacted = plans.some((plan) => plan.compacted > 0);
      return {
        // Text an earlier card Undo took out is taken back too: this Undo has nothing left to do.
        status: accepted
          ? compacted
            ? "partial"
            : "reversed"
          : undoneByWriter
            ? "reversed"
            : "expired",
        // One row per document whose text the steps reversed or left; a document with no text
        // to reverse (it left, or comes back, with its node) has none.
        documents: plans.flatMap((plan): DocumentReversalResult[] => {
          const reversed = committed ? partsOf(plan) : 0;
          const old = plan.compacted;
          if (!reversed && !old) return [];
          return [
            {
              documentId: plan.document.documentId,
              uri: plan.document.uri,
              status: old ? (reversed ? "partial" : "expired") : "reversed",
              ...(old
                ? {
                    text: `${old} of the reply's edits ${old === 1 ? "stays" : "stay"}: the document no longer keeps history that old.`,
                  }
                : {}),
            },
          ];
        }),
      };
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
