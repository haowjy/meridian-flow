import { AsyncLocalStorage } from "node:async_hooks";
import { captureDelta } from "@meridian/agent-edit/content-merge";
import { editHandle, undoInRooms, type WriteOrdinals } from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId, EditOrigin, ThreadId, UserId } from "@meridian/contracts";
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import { type Database, documentEditParts, documentEdits, drafts } from "@meridian/database";
import {
  changedBlocks,
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
import { createDrizzleTreeHistory } from "./drizzle-tree-history.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import { restoreStates } from "./drizzle-turn-restore.js";
import { createTurnTreeInverse, NO_TREE_STEPS } from "./drizzle-turn-tree-inverse.js";

type Dependencies = {
  db: Database;
  ordinals: WriteOrdinals;
  rooms: DocumentRooms<DrizzleDb>;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  resolveLastDocumentUri(documentId: string, draftId?: DraftId): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  notices: import("../domain/reversal-notices.js").TurnInverseNoticePort;
  workProjection: Pick<WorkProjectionMutation, "mutate" | "ownersOf">;
  removals: DocumentRemovals;
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
  const treePlanOf = (query: TurnInverseQuery) =>
    query.model || !query.turnId
      ? Promise.resolve(NO_TREE_STEPS)
      : treeInverse.plan(query.threadId, query.turnId, query.learned);
  async function createdDocumentsOf(query: TurnInverseQuery) {
    return new Set((await treePlanOf(query)).createdDocuments);
  }
  async function selectedDocuments(query: TurnInverseQuery): Promise<DocumentId[]> {
    if (query.model || query.documentIds) return [...new Set(query.documentIds ?? [])].sort();
    return [
      ...new Set((await readTurnEditTargets(db(), query)).map((target) => target.documentId)),
    ].sort();
  }
  const currentRoomOf = (query: Pick<TurnInverseQuery, "model">, documentId: DocumentId) =>
    query.model && currentDestination().kind === "draft"
      ? agentRoomFor(db(), documentId)
      : Promise.resolve(liveRoomOf(documentId));
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
        const docs = await input.rooms.read(one);
        held.push(docs);
        rooms.set(name, { room: one, docs, closed: availability.closed });
      }
      await testHook("inverse.afterCaptureRead");
      documents.push({
        documentId,
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
      let owners: OwnerLocks = {
        workIds: tree.owners.works,
        lineageRootIds: tree.owners.lineages,
      };
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
        ? restoreStates(db(), input.rooms, input.treeLists, query.turnId)
        : Promise.resolve({ offered: [], restored: [] }),
    treeDraftStates: (query, restored) =>
      query.model || !query.turnId
        ? Promise.resolve({})
        : treeInverse.draftStates(query.threadId, query.turnId, restored),
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
            compacted: 0,
            inManuscript: false,
          },
        ]),
      );
      const documents = [...planned.values()];
      const handles: string[] = [];
      const taken: number[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      const tree = kind === "revert" ? NO_TREE_STEPS : await treePlanOf(query);
      const admission = await admitInverse(sequence, query, userId, tree.documents);
      const { grants } = admission;
      const works = {
        works: tree.owners.works,
        lineages: tree.owners.lineages,
      };
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
        compacted: new Map(documents.map((entry) => [entry.documentId, entry.compacted])),
        inManuscript: documents.some((entry) => entry.inManuscript),
      };
    },
  };

  async function admitInverse(
    sequence: readonly { plan: PreparedDocumentInverse; step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
    treeDocuments: readonly { documentId: string; restore: boolean }[],
  ): Promise<{ grants: FileGrant<"edit">[] | null }> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
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
    for (const { documentId, restore } of treeDocuments)
      requirements.set(`${documentId}:live:${restore ? "restore" : "content"}`, {
        documentId: documentId as DocumentId,
        draftId: null,
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
    const by = query.model && query.turnId ? { turn: query.turnId } : undefined;
    const undone = undoInRooms(parts, docsOf, by);
    const taken = parts.filter((part) => !undone.compacted.has(part));
    entry.compacted += undone.compacted.size;
    if (!taken.length || !undone.rooms.length) return { handle: "", parts: 0 };
    const receipts: ReceiptWrite["receipts"] = [];
    for (const { room, changes } of undone.rooms) {
      const name = loroRoomName(room);
      const docs = docsOf(room);
      const batch = encodeChanges(changes);
      await input.rooms.commit(db(), room, batch, "server:inverse");
      entry.wrote = true;
      if (name === loroRoomName(entry.room) || (room.kind === "live" && entry.room.kind === "fork"))
        entry.updates.push(batch);
      const before = seen.get(name);
      if (before?.pending && [...pendingBlocks(docs)].some((id) => !before.pending?.has(id)))
        entry.inManuscript = true;
      const written = [...new Set(changes.map((change) => change.key))];
      const here = taken.filter((part) => loroRoomName(part.room) === name);
      receipts.push({
        origin: (here[0] as UndoablePart).origin,
        targets: here.map((part) => ({ editId: part.editId, ordinal: part.ordinal })),
        ...(before?.blocks
          ? {
              delta: captureDelta(before.blocks, blocksIn(docs)),
              write: { edit: editSince(docs, before.since, written) },
            }
          : {}),
      });
    }
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

const pendingBlocks = (docs: RoomDocs) =>
  new Set(changedBlocks(docs).flatMap((change) => change.blocks));

type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: DocumentId;
  room: DocumentRoom;
  docs: Map<string, RoomDocs>;
  updates: Uint8Array[];
  wrote: boolean;
  reversed: number;
  compacted: number;
  inManuscript: boolean;
};

type InverseCapture = {
  ids: DocumentId[];
  documents: InverseDocument[];
};

const attemptStorage = new AsyncLocalStorage<
  InverseCapture & { deliveries: (() => Promise<void>)[] }
>();
