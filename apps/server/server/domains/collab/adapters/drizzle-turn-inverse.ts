import { editHandle, type WriteOrdinals } from "@meridian/agent-edit/integration";
import type { DocumentId, DraftId, ThreadId, UserId } from "@meridian/contracts";
import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import { type Database, documentEditParts, documentEdits, drafts } from "@meridian/database";
import type { RoomDocs, StoredEdit } from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
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
import type { InverseStep } from "../domain/inverse-stream.js";
import type { UndoablePart } from "../domain/model-reversal-planner.js";
import {
  type CapturedRoom,
  createTurnInverseService,
  type InverseCommitted,
  type InverseDocument,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { agentRoomFor } from "./drizzle-agent-room.js";
import { type ReceiptWrite, recordDocumentEdit } from "./drizzle-document-edits.js";
import { createDrizzleTreeHistory } from "./drizzle-tree-history.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import { restoreStates, roomOfOrigin } from "./drizzle-turn-restore.js";
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
  const currentRoomOf = (query: TurnInverseQuery, documentId: DocumentId) =>
    query.view?.kind === "draft"
      ? agentRoomFor(db(), documentId, query.view)
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
   * Every affected document: its history, and each room the chat's writes landed in (and the one it
   * writes in now). With `held`, each room's copy is read too and pushed there for the caller to
   * free; without, the documents are the ledger's alone (`InverseDocument.copies`).
   */
  async function capture(
    query: TurnInverseQuery,
    ids: DocumentId[],
    held: RoomDocs[] | null,
  ): Promise<InverseDocument[]> {
    const createdDocuments = await createdDocumentsOf(query);
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
        const docs = held ? await input.rooms.read(one) : undefined;
        if (docs) held?.push(docs);
        rooms.set(name, { room: one, docs, closed: availability.closed });
      }
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
        copies: held !== null,
      });
    }
    return documents;
  }
  /** Runs once the transaction commits, or now outside one. */
  async function afterCommit(deliveries: (() => Promise<void>)[]) {
    const deliver = async () => {
      for (const delivery of deliveries) await delivery();
    };
    if (!deferUntilDrizzleCommit(deliver)) await deliver();
  }

  const store: TurnInverseStore = {
    async read(query, use) {
      const held: RoomDocs[] = [];
      try {
        return await use(await capture(query, await selectedDocuments(query), held));
      } finally {
        for (const docs of held) docs.free();
      }
    },
    async run({ query, kind, userId }, select) {
      const ids = await selectedDocuments(query);
      // Off every lock: what the command may write, from the ledger, and the tree receipts the
      // reply left, which lists and Works they write. Its admission chooses the locks.
      const admitting = await select(await capture(query, ids, null));
      await testHook("inverse.afterCaptureRead");
      const tree = kind === "revert" ? NO_TREE_STEPS : await treePlanOf(query);
      if (!admitting.steps.length && !tree.steps.length && !tree.taken.length && !tree.undoneByCard)
        return { value: admitting.value, committed: null };
      await testHook("inverse.beforeCommitScope");
      const { grants, admitted } = await admitInverse(
        admitting.steps,
        query,
        userId,
        tree.documents,
      );
      const works = { works: tree.owners.works, lineages: tree.owners.lineages };
      // What the scope below locks; a Work outside the caller's locks is past their order.
      const effect = mergeOwnerLocks(
        await input.workProjection.ownersOf(works),
        ...(grants ?? []).map((grant) => grantOwnerLocks(grant.facts)),
      );
      const within = (held: OwnerLocks, owners: OwnerLocks) =>
        owners.workIds.every((id) => held.workIds.includes(id)) &&
        owners.lineageRootIds.every((id) => held.lineageRootIds.includes(id));
      if (query.declared && !within(query.declared, effect)) throw new TreeOwnersMoved([], effect);
      const held: RoomDocs[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      let result: { value: (typeof admitting)["value"]; committed: InverseCommitted } | undefined;
      const operation = async () => {
        // Under the document keys: the selection runs again on the committed text, and its steps
        // commit what they took on these copies.
        const selection = await select(await capture(query, ids, held));
        // A write since the ledger read put an edit in a room the admission didn't grant.
        for (const { step } of selection.steps)
          for (const part of step.parts)
            if (admitted && !admitted.has(contentKey(part.documentId, part.room)))
              throw new TreeOwnersMoved();
        const committed: InverseCommitted = {
          handles: [],
          updates: [],
          treeReversed: 0,
          inManuscript: false,
        };
        const wrote = new Set<DocumentId>();
        for (const { document, step } of selection.steps) {
          const done = await commitStep(document, step, userId, query);
          if (done.handle) committed.handles.push(done.handle);
          committed.updates.push(...done.updates);
          committed.inManuscript ||= done.inManuscript;
          wrote.add(document.documentId);
        }
        // A node a reply made is taken back once the text written into it is.
        if (tree.steps.length || tree.taken.length || tree.undoneByCard) {
          const now = await treePlanOf(query);
          const locked = new Set(tree.lists.map((list) => JSON.stringify(list)));
          if (now.lists.some((list) => !locked.has(JSON.stringify(list))))
            throw new TreeOwnersMoved();
          // The owners moved since the locks were chosen: past their order, so the caller runs again.
          const owners = { workIds: now.owners.works, lineageRootIds: now.owners.lineages };
          if (!within(effect, owners)) throw new TreeOwnersMoved([], owners);
          committed.treeReversed = (
            await treeInverse.run(now, { threadId: query.threadId, userId })
          ).reversed;
        }
        for (const documentId of wrote) deliveries.push(() => settle(documentId, kind, query));
        result = { value: selection.value, committed };
      };
      let outcome: Awaited<ReturnType<typeof runEditAdmission>>;
      try {
        outcome = await runEditAdmission({
          fileAccess: input.fileAccess,
          grants,
          workProjection: input.workProjection,
          works,
          commitScope: (operation) => runInDrizzleSavepoint(input.db, operation),
          acquireMutationScope: async () => {
            // The lists' keys come before every document key (the order in collab's CONTEXT.md).
            if (tree.lists.length) await input.treeLists.lock(tree.lists);
            for (const id of [...new Set([...ids, ...(query.alsoLock ?? [])])].sort())
              await lockDocumentMutation(db(), id);
          },
          operation,
        });
      } finally {
        for (const docs of held) docs.free();
      }
      if (!outcome.ok) throw outcome.refusal;
      if (!result) throw new Error("An admitted inverse ran no operation");
      // Delivery reads the documents' rooms: only once the inverse committed.
      await afterCommit(deliveries);
      return result;
    },
    async ownersOf(query, userId) {
      const ids = await selectedDocuments(query);
      const tree = await treePlanOf(query);
      // The Works and chats whose notes the tree steps change.
      let owners: OwnerLocks = {
        workIds: tree.owners.works,
        lineageRootIds: tree.owners.lineages,
      };
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
  };

  async function admitInverse(
    sequence: readonly { step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
    treeDocuments: readonly { documentId: string; restore: boolean }[],
  ): Promise<{ grants: FileGrant<"edit">[] | null; admitted: Set<string> | null }> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
    // Every inverse supplies its principal explicitly; an absent one here means a composition
    // bug, not live routing.
    if (!principal) return { grants: null, admitted: null };
    const requirements = new Map<
      string,
      { documentId: DocumentId; draftId: DraftId | null; restore: boolean }
    >();
    for (const { step } of sequence)
      for (const { documentId, room } of step.parts) {
        const draftId = room.kind === "fork" ? room.draftId : null;
        requirements.set(`${contentKey(documentId, room)}:content`, {
          documentId,
          draftId,
          restore: false,
        });
      }
    // A tree change is taken back by the one who may edit that document; a document in Trash
    // may only be restored.
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
    return {
      grants,
      admitted: new Set(
        sequence.flatMap(({ step }) =>
          step.parts.map((part) => contentKey(part.documentId, part.room)),
        ),
      ),
    };
  }

  /**
   * One step inside the commit scope: each room's batch (what the step took back there) committed
   * into it, and one receipt of kind `undo` or `revert` with a part per room, naming the parts it
   * took there, with the model's chat and write ordinal or the writer.
   */
  async function commitStep(
    document: InverseDocument,
    step: InverseStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<{ handle: string; updates: Uint8Array[]; inManuscript: boolean }> {
    const { documentId } = document;
    const receipts: ReceiptWrite["receipts"] = [];
    const updates: Uint8Array[] = [];
    let inManuscript = false;
    for (const taken of step.rooms) {
      await input.rooms.commit(db(), taken.room, taken.batch, "server:inverse");
      // The reply's later writes plan on the batches the room it writes in holds: its own, and
      // Live's in a fork, whose texts read Live's.
      if (
        loroRoomName(taken.room) === loroRoomName(document.room) ||
        (taken.room.kind === "live" && document.room.kind === "fork")
      )
        updates.push(taken.batch);
      inManuscript ||= taken.inManuscript;
      receipts.push({
        // The parts' own origin: the room, and the draft a Live room's text was written for.
        origin: (taken.parts[0] as UndoablePart).origin,
        targets: taken.parts.map((part) => ({ editId: part.editId, ordinal: part.ordinal })),
        // The model's inverse is an edit on its stack: a later Undo or revert reads it back.
        ...(taken.model ? { delta: taken.model.delta, write: { edit: taken.model.edit } } : {}),
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
    return { handle: wId === undefined ? "" : editHandle(wId), updates, inManuscript };
  }

  /** After the commit: the document's projections, and the turn's notice. */
  async function settle(documentId: DocumentId, kind: "undo" | "revert", query: TurnInverseQuery) {
    await input.refreshDocument(documentId);
    if (kind !== "revert" && !query.model && query.turnId)
      await input.notices.record({
        docId: documentId,
        threadId: query.threadId,
        turnId: query.turnId,
        sweptContent: false,
        beforeContentRef: null,
      });
  }

  const service = createTurnInverseService(store);
  const treeHistory = createDrizzleTreeHistory(input.db, input.ordinals, (threadId, documentId) =>
    service.modelStack(documentId as DocumentId, threadId),
  );
  return service;
}

const liveRoomOf = (documentId: DocumentId): DocumentRoom => ({ kind: "live", documentId });

/** What an admission grants a step to write: the document in Live, or in a draft. */
const contentKey = (documentId: DocumentId, room: DocumentRoom) =>
  `${documentId}:${room.kind === "fork" ? room.draftId : "live"}`;
