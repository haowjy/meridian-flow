/**
 * Durable multi-document inverse admission: a lock-free capture that plans which steps run, and
 * one commit scope whose steps resolve against the committed text under the documents' keys;
 * delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { captureDelta } from "@meridian/agent-edit/content-merge";
import { editHandle, undoInRooms, type WriteOrdinals } from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId, EditOrigin, ThreadId, UserId } from "@meridian/contracts";
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import { type Database, documentEditParts, documentEdits, drafts } from "@meridian/database";
import {
  changedBlocks,
  type DocVersion,
  editSince,
  encodeChanges,
  type RoomDocs,
  type RoomVersion,
  readDocument,
  type StoredEdit,
} from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { nodeOf } from "@meridian/loro-prosemirror";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Node as PMNode } from "prosemirror-model";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { draftOwnerSql, mergeOwnerLocks, type OwnerLocks } from "../../../shared/draft-owner.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import { TreeOwnersMoved } from "../../../shared/tree-owners.js";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import {
  type FileAccess,
  FileEditRefusedError,
  type FileGrant,
  grantOwnerLocks,
  isFileAccessDenied,
  runEditAdmission,
} from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { currentDestination } from "../domain/agent-destination.js";
import { inverseSchema } from "../domain/edit-excerpt.js";
import type { InverseStep } from "../domain/inverse-stream.js";
import { type UndoablePart, undoable } from "../domain/model-reversal-planner.js";
import {
  type CapturedRoom,
  createTurnInverseService,
  type InverseDocument,
  type PreparedDocumentInverse,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { agentRoomFor } from "./drizzle-agent-room.js";
import { type ReceiptWrite, recordDocumentEdit } from "./drizzle-document-edits.js";
import { restoreStates } from "./drizzle-restore-before.js";
import { createDrizzleTreeHistory } from "./drizzle-tree-history.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import { createTurnTreeInverse, NO_TREE_STEPS } from "./drizzle-turn-tree-inverse.js";

type Dependencies = {
  db: Database;
  /** The write ordinals the model's inverses take; the tree history reads it too. */
  ordinals: WriteOrdinals;
  /** The text an inverse reads and commits into: Live's, or a Draft chat's fork. */
  rooms: DocumentRooms<DrizzleDb>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  /** Where a document in Trash last stood, which names it while a Redo brings it back. */
  resolveLastDocumentUri(documentId: string, draftId?: DraftId): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  notices: import("../domain/reversal-notices.js").TurnInverseNoticePort;
  /** A revert changes pending membership, so it reconciles the Works' counts through it. */
  workProjection: Pick<WorkProjectionMutation, "mutate" | "ownersOf">;
  /** A removed document's text is not reversed; its record words the refusal. */
  removals: DocumentRemovals;
  /** The tree half of a card's reversal: the reply's tree receipts, in the lists that hold them. */
  treeLists: Pick<TreeListStore, "lock" | "read" | "submit">;
  fileAccess: Pick<
    FileAccess,
    "authorizeAt" | "authorize" | "confirmEdit" | "destinationAvailability"
  >;
};

export function createDrizzleTurnInverseService(input: Dependencies) {
  const db = () => currentDrizzleDb(input.db);
  const treeInverse = createTurnTreeInverse({
    db: input.db,
    treeLists: input.treeLists,
    // The receipts' own adapter; its text stack is this service's, read once it exists.
    history: () => treeHistory,
  });
  /** A card's reversal takes the reply's tree receipts too; the model's own tools take their own. */
  const treePlanOf = (query: TurnInverseQuery) =>
    query.model || !query.turnId
      ? Promise.resolve(NO_TREE_STEPS)
      : treeInverse.plan(query.threadId, query.turnId, query.learned);
  /**
   * An Undo that deletes a created document leaves its text with the document.
   */
  async function createdDocumentsOf(query: TurnInverseQuery) {
    return new Set((await treePlanOf(query)).createdDocuments);
  }
  async function selectedDocuments(query: TurnInverseQuery): Promise<DocumentId[]> {
    if (query.model || query.documentIds) return [...new Set(query.documentIds ?? [])].sort();
    return [
      ...new Set((await readTurnEditTargets(db(), query)).map((target) => target.documentId)),
    ].sort();
  }
  /**
   * The room the chat writes `documentId` in now (`agentRoomFor`): the model's answer names it, and
   * its batches there join the reply's frontier. A card's query has no chat destination: Live.
   */
  const currentRoomOf = (query: Pick<TurnInverseQuery, "model">, documentId: DocumentId) =>
    query.model && currentDestination().kind === "draft"
      ? agentRoomFor(db(), documentId)
      : Promise.resolve(liveRoomOf(documentId));
  /**
   * The documents' parts an inverse of `threadId` reads, in order, each in the room it was written
   * in: the chat's own, and every Undo and revert (which name the parts they took). A fork part
   * whose draft is gone has nothing to come back to.
   */
  async function history(documentIds: DocumentId[], threadId: string) {
    if (!documentIds.length) return [];
    const rows = await db()
      .select({
        part: {
          id: documentEditParts.id,
          editId: documentEditParts.editId,
          ordinal: documentEditParts.ordinal,
          targets: documentEditParts.targets,
          delta: documentEditParts.delta,
          edit: documentEditParts.edit,
          origin: documentEditParts.origin,
        },
        edit: documentEdits,
      })
      .from(documentEditParts)
      .innerJoin(documentEdits, eq(documentEditParts.editId, documentEdits.id))
      .where(
        and(
          inArray(documentEdits.documentId, documentIds),
          or(eq(documentEdits.threadId, threadId as ThreadId), ne(documentEdits.kind, "write")),
          sql`(${documentEditParts.origin}->>'kind' = 'live' OR EXISTS (
            SELECT 1 FROM ${drafts} WHERE ${drafts.id} = ${documentEditParts.origin}->>'draftId'))`,
        ),
      )
      .orderBy(documentEditParts.id);
    return rows.map(({ part, edit }) => ({
      ...part,
      room: roomOfOrigin(part.origin, edit.documentId),
      edit: part.edit as StoredEdit | null,
      kind: edit.kind,
      actionId: edit.actionId,
      documentId: edit.documentId,
      threadId: edit.threadId,
      turnId: edit.turnId,
      responseId: edit.responseId,
      toolCallId: edit.toolCallId,
      actor: edit.actor,
      wId: edit.wId,
    }));
  }
  /**
   * Every affected document as the plan will see it: the history, and each room the chat's writes
   * landed in (and the one it writes in now) as read now. Taken with no lock, so it only chooses
   * the steps; each step reads the committed text it writes. The rooms' copies go into `held` as
   * they are read, for the attempt to free.
   */
  async function capture(query: TurnInverseQuery, held: RoomDocs[]): Promise<InverseCapture> {
    const createdDocuments = await createdDocumentsOf(query);
    const ids = await selectedDocuments(query);
    const parts: StoredInversePart[] = await history(ids, query.threadId);
    const partsByDocument = new Map<string, StoredInversePart[]>();
    for (const part of parts) {
      const list = partsByDocument.get(part.documentId);
      if (list) list.push(part);
      else partsByDocument.set(part.documentId, [part]);
    }
    const documents: InverseDocument[] = [];
    const removals = await input.removals.lookup(ids);
    for (const documentId of ids) {
      const removal = removals.get(documentId) ?? null;
      const room = await currentRoomOf(query, documentId);
      const history = partsByDocument.get(documentId) ?? [];
      const wanted = new Map([[loroRoomName(room), room]]);
      for (const part of history)
        if (part.threadId === query.threadId) wanted.set(loroRoomName(part.room), part.room);
      const rooms = new Map<string, CapturedRoom>();
      for (const [name, one] of wanted) {
        const availability = await input.fileAccess.destinationAvailability(
          one.kind === "fork"
            ? { kind: "draft", documentId, draftId: one.draftId }
            : { kind: "document", documentId },
          one.kind === "fork"
            ? { kind: "draft", draftId: one.draftId, ownerHandle: null }
            : { kind: "live" },
        );
        // A delete keeps the document's rooms: its inverse plans over the retained text.
        const docs = await input.rooms.read(one);
        held.push(docs);
        rooms.set(name, { room: one, docs, closed: availability.closed });
      }
      await testHook("inverse.afterCaptureRead");
      documents.push({
        documentId,
        // A deleted document has no address: the model's path, or where it last stood.
        uri:
          (await input.resolveDocumentUri(documentId)) ??
          query.path ??
          (await input.resolveLastDocumentUri(documentId)) ??
          documentId,
        room,
        rooms,
        removal,
        createdInTurn: createdDocuments.has(documentId),
        history,
      });
    }
    return { ids, documents };
  }

  /**
   * An inverse's one attempt: a capture plans the steps, `run` commits them in one savepoint. The
   * steps read the committed text under their locks, so a write between the capture and the
   * commit changes what they take, never whether the inverse runs. Deliveries wait for the commit.
   */
  async function attempts<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T> {
    const deliveries: (() => Promise<void>)[] = [];
    const held: RoomDocs[] = [];
    let result: T;
    try {
      const captured = await capture(query, held);
      result = await attemptStorage.run({ ...captured, deliveries }, () => run(captured.documents));
    } finally {
      for (const docs of held) docs.free();
    }
    // Delivery reads the documents through their coordinators: only once the attempt completed.
    const deliver = async () => {
      for (const delivery of deliveries) await delivery();
    };
    if (!deferUntilDrizzleCommit(deliver)) await deliver();
    return result;
  }

  const store: TurnInverseStore = {
    withCapturedDocuments: attempts,
    async ownersOf(query, userId) {
      const ids = await selectedDocuments(query);
      const tree = await treePlanOf(query);
      let owners = mergeOwnerLocks(
        await input.workProjection.ownersOf({ drafts: tree.drafts }),
        // The Works and chats whose notes the tree steps change.
        { workIds: tree.owners.works, lineageRootIds: tree.owners.lineages },
      );
      // Each document's own Work, which its write grant locks with the draft's.
      const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
      if (principal)
        for (const documentId of new Set([...ids, ...tree.documents.map((d) => d.documentId)])) {
          const grant = await input.fileAccess.authorizeAt(
            principal,
            { kind: "document", documentId: documentId as DocumentId },
            { kind: "live" },
            "edit",
          );
          if (!isFileAccessDenied(grant))
            owners = mergeOwnerLocks(owners, grantOwnerLocks(grant.facts));
        }
      return owners;
    },
    restoreStates: (query) =>
      query.turnId
        ? restoreStates(db(), input.rooms, query.turnId)
        : Promise.resolve({ offered: [], restored: [] }),
    treeDraftStates: (query) =>
      query.model || !query.turnId
        ? Promise.resolve({})
        : treeInverse.draftStates(query.threadId, query.turnId),
    async treeSteps(query) {
      const tree = await treePlanOf(query);
      return {
        acting: tree.steps.length,
        taken: tree.taken.length + tree.undoneByCard,
      };
    },
    readHistory: (documentId, threadId) => history([documentId], threadId),
    async commit({ plans, sequence, kind, userId, query }) {
      const attempt = attemptStorage.getStore();
      if (!attempt) throw new Error("An inverse commits only inside its captured attempt");
      await testHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with provenance on its attempt-local view.
      const planned = new Map(
        plans.map((plan): [PreparedDocumentInverse, PlannedInverse] => [
          plan,
          {
            plan,
            documentId: plan.document.documentId,
            room: plan.document.room,
            docs: new Map(),
            updates: [],
            wrote: false,
            reversed: 0,
            stayed: 0,
            compacted: 0,
            inManuscript: false,
          },
        ]),
      );
      const documents = [...planned.values()];
      const handles: string[] = [];
      const taken: number[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      // Off every lock: the tree receipts the reply left, which lists and Works they write.
      const tree = kind === "revert" ? NO_TREE_STEPS : await treePlanOf(query);
      const admission = await admitInverse(sequence, query, userId, tree.documents);
      const { grants } = admission;
      const works = {
        drafts: tree.drafts,
        works: tree.owners.works,
        lineages: tree.owners.lineages,
      };
      // What the scope below locks; a Work outside the caller's locks is past their order.
      const effect = mergeOwnerLocks(
        await input.workProjection.ownersOf(works),
        ...(grants ?? []).map((grant) => grantOwnerLocks(grant.facts)),
      );
      const within = (held: OwnerLocks, owners: OwnerLocks) =>
        owners.workIds.every((id) => held.workIds.includes(id)) &&
        owners.lineageRootIds.every((id) => held.lineageRootIds.includes(id));
      if (query.declared && !within(query.declared, effect)) throw new TreeOwnersMoved([], effect);
      let treeReversed = 0;
      const operation = async () => {
        // Each step plans again on the text it finds here, under the document key, so Live is
        // read now, not as the capture saw it.
        for (const entry of documents)
          for (const [name, { room }] of entry.plan.document.rooms)
            entry.docs.set(name, await input.rooms.read(room));
        const runText = async () => {
          for (const { plan, step } of sequence) {
            const entry = planned.get(plan);
            if (!entry) throw new Error("A step's plan is not among the commit's plans");
            const done = await commitStep(entry, step, userId, query);
            if (done.handle) handles.push(done.handle);
            taken.push(done.parts);
          }
        };
        const runTree = async () => {
          if (!tree.steps.length && !tree.taken.length && !tree.undoneByCard) return;
          const now = await treePlanOf(query);
          const locked = new Set(tree.lists.map((list) => JSON.stringify(list)));
          if (now.lists.some((list) => !locked.has(JSON.stringify(list))))
            throw new TreeOwnersMoved();
          // The owners moved since the locks were chosen: past their order, so the caller runs again.
          const owners = { workIds: now.owners.works, lineageRootIds: now.owners.lineages };
          if (!within(effect, owners)) throw new TreeOwnersMoved([], owners);
          const done = await treeInverse.run(now, {
            threadId: query.threadId,
            userId,
          });
          treeReversed = done.reversed;
        };
        // A node a reply made is taken back once the text written into it is.
        await runText();
        await runTree();
        for (const entry of documents) await settleDocument(entry, kind, query, deliveries);
      };
      let admitted: Awaited<ReturnType<typeof runEditAdmission>>;
      try {
        admitted = await runEditAdmission({
          fileAccess: input.fileAccess,
          grants,
          workProjection: input.workProjection,
          works,
          commitScope: (operation) => runInDrizzleSavepoint(input.db, operation),
          acquireMutationScope: async () => {
            // The lists' keys come before every document key (the order in collab's CONTEXT.md).
            if (tree.lists.length) await input.treeLists.lock(tree.lists);
            const ids = new Set([...attempt.ids, ...(query.alsoLock ?? [])]);
            for (const id of [...ids].sort()) await lockDocumentMutation(db(), id);
          },
          operation,
        });
      } finally {
        for (const entry of documents) for (const docs of entry.docs.values()) docs.free();
      }
      if (!admitted.ok) throw admitted.refusal;
      attempt.deliveries.push(...deliveries);
      return {
        handles,
        taken,
        updates: documents.flatMap((entry) => entry.updates),
        treeReversed,
        reversed: new Map(documents.map((entry) => [entry.documentId, entry.reversed])),
        stayed: new Map(documents.map((entry) => [entry.documentId, entry.stayed])),
        compacted: new Map(documents.map((entry) => [entry.documentId, entry.compacted])),
        inManuscript: documents.some((entry) => entry.inManuscript),
      };
    },
  };

  async function admitInverse(
    sequence: readonly { plan: PreparedDocumentInverse; step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
    treeDocuments: readonly { documentId: string; draftId: DraftId | null; restore: boolean }[],
  ): Promise<{ grants: FileGrant<"edit">[] | null }> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
    // Every inverse supplies its principal explicitly; an absent one here means a composition
    // bug, not live routing.
    if (!principal) return { grants: null };
    const requirements = new Map<
      string,
      { documentId: DocumentId; draftId: DraftId | null; restore: boolean }
    >();
    for (const { step } of sequence)
      for (const { documentId, room } of step.parts) {
        const draftId = room.kind === "fork" ? room.draftId : null;
        requirements.set(`${documentId}:${draftId ?? "live"}:content`, {
          documentId,
          draftId,
          restore: false,
        });
      }
    // A tree change is taken back where it was made, by the one who may edit that document; a
    // live document in Trash may only be restored.
    for (const { documentId, draftId, restore } of treeDocuments)
      requirements.set(`${documentId}:${draftId ?? "live"}:${restore ? "restore" : "content"}`, {
        documentId: documentId as DocumentId,
        draftId,
        restore,
      });
    const admittedRequirements = [...requirements.values()];
    const draftIds = [
      ...new Set(admittedRequirements.flatMap((r) => (r.draftId ? [r.draftId] : []))),
    ];
    const owner = draftOwnerSql();
    const holders = draftIds.length
      ? await db()
          .select({ draftId: drafts.id, handle: owner.handle })
          .from(drafts)
          .where(inArray(drafts.id, draftIds))
      : [];
    const byDraft = new Map(holders.map((holder) => [holder.draftId, holder]));
    const grants: FileGrant<"edit">[] = [];
    for (const requirement of admittedRequirements) {
      const holder = requirement.draftId ? byDraft.get(requirement.draftId) : undefined;
      // A tree change's draft purged since restarts the command.
      if (requirement.draftId && !holder) throw new TreeOwnersMoved();
      const grant = await input.fileAccess.authorizeAt(
        principal,
        holder
          ? { kind: "draft", documentId: requirement.documentId, draftId: holder.draftId }
          : requirement.restore
            ? { kind: "restore", documentId: requirement.documentId }
            : { kind: "document", documentId: requirement.documentId },
        holder
          ? { kind: "draft", draftId: holder.draftId, ownerHandle: holder.handle }
          : { kind: "live" },
        "edit",
      );
      if (isFileAccessDenied(grant)) throw new FileEditRefusedError([grant]);
      grants.push(grant);
    }
    return { grants };
  }

  /**
   * One step inside the commit scope: its parts taken back on the committed rooms, each in the room
   * it was written in, by design §2's Undo rule, newest first (`undoInRooms`: a part someone wrote
   * over between the capture and the lock stays whole), each room's changes committed into it as
   * one batch, and one receipt of kind `undo` or `revert` with a part per room, naming the parts it
   * took there, with the model's chat and write ordinal or the writer.
   */
  async function commitStep(
    entry: PlannedInverse,
    step: InverseStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<{ handle: string; parts: number }> {
    const { documentId } = entry;
    const docsOf = (room: DocumentRoom) => {
      const docs = entry.docs.get(loroRoomName(room));
      if (!docs) throw new Error("A step runs inside the commit scope, in a captured room");
      return docs;
    };
    const parts = step.parts.filter(undoable);
    const seen = new Map<
      string,
      { since: RoomVersion; blocks: PMNode[] | null; pending: Set<string> | null }
    >();
    for (const { room } of parts) {
      const name = loroRoomName(room);
      if (seen.has(name)) continue;
      const docs = docsOf(room);
      seen.set(name, {
        since: docs.shownVersion(),
        blocks: query.model ? blocksIn(docs) : null,
        pending: room.kind === "fork" ? pendingBlocks(docs) : null,
      });
    }
    // The model's inverse names its turn, as its writes do; the writer's card Undo is the user's.
    const by = query.model && query.turnId ? { turn: query.turnId } : undefined;
    const undone = undoInRooms(parts, docsOf, by);
    const taken = parts.filter((part) => !undone.stayed.has(part));
    for (const why of undone.stayed.values())
      if (why.kind === "compacted") entry.compacted++;
      else entry.stayed++;
    if (!taken.length || !undone.rooms.length) return { handle: "", parts: 0 };
    const receipts: ReceiptWrite["receipts"] = [];
    for (const { room, changes } of undone.rooms) {
      const name = loroRoomName(room);
      const docs = docsOf(room);
      const batch = encodeChanges(changes);
      await input.rooms.commit(db(), room, batch, "server:inverse");
      entry.wrote = true;
      // The reply's later writes plan on the batches the room it writes in holds: its own, and
      // Live's in a fork, whose texts read Live's.
      if (name === loroRoomName(entry.room) || (room.kind === "live" && entry.room.kind === "fork"))
        entry.updates.push(batch);
      const before = seen.get(name);
      // A draft that now differs from Live where it didn't: Live still holds what came out.
      if (before?.pending && [...pendingBlocks(docs)].some((id) => !before.pending?.has(id)))
        entry.inManuscript = true;
      const written = [...new Set(changes.map((change) => change.key))];
      const here = taken.filter((part) => loroRoomName(part.room) === name);
      receipts.push({
        // The parts' own origin: the room, and the draft a Live room's text was written for.
        origin: (here[0] as UndoablePart).origin,
        targets: here.map((part) => ({ editId: part.editId, ordinal: part.ordinal })),
        // The model's inverse is an edit on its stack: it records its delta and its edit, which a
        // later Undo or revert reads back.
        ...(before?.blocks
          ? {
              delta: captureDelta(before.blocks, blocksIn(docs)),
              write: { edit: editSince(docs, before.since, docs.peer, written) },
            }
          : {}),
      });
    }
    // It takes the next write ordinal, as a write does.
    const wId = query.model
      ? await input.ordinals.reserveWriteOrdinal(documentId, query.threadId)
      : undefined;
    await recordDocumentEdit(db(), {
      documentId,
      ...(query.model
        ? {
            actor: "agent" as const,
            threadId: query.threadId,
            turnId: query.turnId,
            responseId: query.responseIdentity?.modelResponseId,
            toolCallId: query.toolCallId,
          }
        : { actor: "human" as const }),
      wId,
      actorUserId: userId,
      kind: step.actionKind,
      actionId: step.actionId,
      receipts,
    });
    entry.reversed += taken.length;
    return {
      handle: wId === undefined ? "" : editHandle(wId),
      parts: taken.length,
    };
  }

  /** After every step: the document's projections and the turn's notice, once it commits. */
  async function settleDocument(
    entry: PlannedInverse,
    kind: "undo" | "revert",
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<void> {
    if (!entry.wrote) return;
    const { documentId } = entry;
    deliveries.push(async () => {
      await input.refreshDocument(documentId);
      if (kind !== "revert" && !query.model && query.turnId)
        await input.notices.record({
          docId: documentId,
          threadId: query.threadId,
          turnId: query.turnId,
          sweptContent: false,
          beforeContentRef: null,
        });
    });
  }

  const service = createTurnInverseService(store);
  const treeHistory = createDrizzleTreeHistory(input.db, input.ordinals, (threadId, documentId) =>
    service.modelStack(documentId as DocumentId, threadId),
  );
  return service;
}

const liveRoomOf = (documentId: DocumentId): DocumentRoom => ({ kind: "live", documentId });

const roomOfOrigin = (origin: EditOrigin, documentId: DocumentId): DocumentRoom =>
  origin.kind === "fork"
    ? { kind: "fork", draftId: origin.draftId as DraftId, documentId }
    : liveRoomOf(documentId);

const blocksIn = (docs: RoomDocs) =>
  readDocument(docs).map((block) => nodeOf(inverseSchema, block));

/** The blocks a draft's copy holds a change in (`changedBlocks`). */
const pendingBlocks = (docs: RoomDocs) =>
  new Set(changedBlocks(docs).flatMap((change) => change.blocks));

/** What a commit builds up for one document: what its steps wrote, for delivery and the answer. */
type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: DocumentId;
  /** The room the chat writes the document in now. */
  room: DocumentRoom;
  /** Each captured room as the commit scope found it, by room name, which the steps write through; freed at the scope's end. */
  docs: Map<string, RoomDocs>;
  /** The batches the steps committed that the chat's room holds: the reply's frontier takes them. */
  updates: Uint8Array[];
  /** Whether the steps committed anything, in any room. */
  wrote: boolean;
  /** Text parts the steps took. */
  reversed: number;
  /** Text parts the steps found written over under the locks, and left whole. */
  stayed: number;
  /** Text parts whose history the room cut, left as they are. */
  compacted: number;
  /** A step took text out of a draft that Live still holds (an Apply put it there). */
  inManuscript: boolean;
};

type InverseCapture = {
  ids: DocumentId[];
  documents: InverseDocument[];
};

/** The attempt a store call runs in: its capture, and the deliveries that wait for its commit. */
const attemptStorage = new AsyncLocalStorage<
  InverseCapture & { deliveries: (() => Promise<void>)[] }
>();
