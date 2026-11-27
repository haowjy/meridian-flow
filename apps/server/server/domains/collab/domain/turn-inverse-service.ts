import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { StoredDelta } from "@meridian/agent-edit/content-merge";
import { editHandle } from "@meridian/agent-edit/integration";
import type {
  CommandId,
  DocumentId,
  DraftId,
  EditOrigin,
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
import { createCapturedReversalPlanner } from "./model-reversal-planner.js";

type EditKind = "write" | "undo" | "revert";
export type EditTarget = { editId: string; ordinal: number };

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
  room: DocumentRoom;
  delta: StoredDelta | null;
  edit: StoredEdit | null;
};
export type TurnInverseQuery = {
  threadId: ThreadId;
  turnId?: TurnId;
  responseIdentity?: import("@meridian/contracts").ResponseAuthorship;
  toolCallId?: string;
  model?: boolean;
  documentIds?: DocumentId[];
  path?: string;
  principal?: Principal;
  /**
   * Documents the caller writes after the inverse, in the same transaction: a commit takes their
   * keys with its own, in one ID order after the list keys.
   */
  alsoLock?: readonly DocumentId[];
  declared?: OwnerLocks;
  learned?: Learned;
};
export type CapturedRoom = {
  room: DocumentRoom;
  docs: RoomDocs;
  closed: ClosedOwnerWhy | null;
};
export type InverseDocument = {
  documentId: DocumentId;
  uri: string;
  room: DocumentRoom;
  rooms: ReadonlyMap<string, CapturedRoom>;
  removal: DocumentRemovalRecord | null;
  createdInTurn: boolean;
  history: StoredInversePart[];
};
export type PreparedDocumentInverse = {
  document: InverseDocument;
  steps: InverseStep[];
  compacted?: number;
};
export interface TurnInverseStore {
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
  treeSteps(query: TurnInverseQuery): Promise<{ acting: number; taken: number }>;
  restoreStates(
    query: TurnInverseQuery,
  ): Promise<{ offered: DraftId[]; restored: { draft: DraftId; press: CommandId }[] }>;
  treeDraftStates(
    query: TurnInverseQuery,
    restored: readonly { draft: DraftId; press: CommandId }[],
  ): Promise<Record<string, TurnDraftState>>;
  readHistory(documentId: DocumentId, threadId: string): Promise<StoredInversePart[]>;
  commit(input: {
    plans: PreparedDocumentInverse[];
    sequence: { plan: PreparedDocumentInverse; step: InverseStep }[];
    kind: "undo" | "revert";
    userId?: UserId;
    query: TurnInverseQuery;
  }): Promise<{
    handles: string[];
    taken: number[];
    updates: Uint8Array[];
    treeReversed: number;
    reversed: ReadonlyMap<DocumentId, number>;
    compacted?: ReadonlyMap<DocumentId, number>;
    inManuscript?: boolean;
  }>;
}
type TurnRow = Pick<StoredInversePart, "kind" | "threadId" | "turnId" | "origin">;
const targetsTurn = (part: TurnRow, query: TurnInverseQuery) =>
  (part.kind === "write" || part.kind === "revert") &&
  part.threadId === query.threadId &&
  part.turnId === query.turnId &&
  !part.origin.draftId;

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
    try {
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
        const { taken, compacted: cut } = entryPlanner.planTakeOut(planned.selection);
        compacted += cut;
        if (taken.length)
          steps.push({ parts: taken, actionId, actionKind: planned.actionKind, at });
      }
      steps.sort((a, b) => b.at - a.at);
      return { document, steps, compacted };
    } finally {
      entryPlanner.free();
    }
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
            : {
                treeReversed: 0,
                reversed: new Map<DocumentId, number>(),
                compacted: undefined,
              };
        const accepted =
          committed.treeReversed + [...committed.reversed.values()].reduce((n, m) => n + m, 0);
        const compactedIn = (plan: PreparedDocumentInverse) =>
          (plan.compacted ?? 0) + (committed.compacted?.get(plan.document.documentId) ?? 0);
        const compacted = plans.some((plan) => compactedIn(plan) > 0);
        return {
          status: accepted
            ? compacted
              ? "partial"
              : "reversed"
            : undoneByWriter
              ? "reversed"
              : "expired",
          documents: plans.flatMap((plan): DocumentReversalResult[] => {
            const reversed = committed.reversed.get(plan.document.documentId) ?? 0;
            const old = compactedIn(plan);
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
      });
    },
  };
}
export type TurnInverseService = ReturnType<typeof createTurnInverseService>;
