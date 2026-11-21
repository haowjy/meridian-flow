/**
 * Durable multi-document inverse admission: a lock-free capture that plans which steps run, and
 * one commit scope whose steps resolve against the committed text under the documents' keys;
 * delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { editHandle, type UpdateJournal } from "@meridian/agent-edit/integration";
import {
  captureMutationUpdates,
  type ItemRanges,
  textInRanges,
} from "@meridian/agent-edit/yjs-mutation";
import type { DocumentId, DraftId, UserId } from "@meridian/contracts";
import { type Database, documentEditParts, documentEdits, drafts } from "@meridian/database";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { draftOwnerSql, mergeOwnerLocks, type OwnerLocks } from "../../../shared/draft-owner.js";
import {
  currentDrizzleDb,
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
import { inverseSchema, takeBack } from "../domain/inverse-text.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import {
  createTurnInverseService,
  type InverseDocument,
  type PreparedDocumentInverse,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import {
  captureReceiptRows,
  type ReceiptWrite,
  recordDocumentEdit,
} from "./drizzle-document-edits.js";
import { createDrizzleTreeHistory } from "./drizzle-tree-history.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import { createTurnTreeInverse, NO_TREE_STEPS } from "./drizzle-turn-tree-inverse.js";

type Dependencies = {
  db: Database;
  journal: UpdateJournal;
  coordinator: LiveDocumentCoordinator;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  /** Where a document in Trash last stood, which names it while a Redo brings it back. */
  resolveLastDocumentUri(documentId: string, branchId?: DraftId): Promise<string | null>;
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
  async function history(documentIds: DocumentId[]) {
    if (!documentIds.length) return [];
    const rows = await db()
      .select({
        part: {
          id: documentEditParts.id,
          editId: documentEditParts.editId,
          ordinal: documentEditParts.ordinal,
          effect: documentEditParts.effect,
          targets: documentEditParts.targets,
          delta: documentEditParts.delta,
          origin: documentEditParts.origin,
        },
        edit: documentEdits,
      })
      .from(documentEditParts)
      .innerJoin(documentEdits, eq(documentEditParts.editId, documentEdits.id))
      .where(inArray(documentEdits.documentId, documentIds))
      .orderBy(documentEditParts.id);
    return rows.map(({ part, edit }) => ({
      ...part,
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
  async function materialize(documentId: DocumentId): Promise<{ doc: Y.Doc; room: string | null }> {
    const snapshot = await input.journal.read(documentId);
    const doc = new Y.Doc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return {
      doc,
      room: snapshot.authority ? liveRoom(documentId, snapshot.authority.generation) : null,
    };
  }
  /**
   * Every affected document as the plan will see it: Live and the history. Taken with no lock, so
   * it only chooses the steps; each step reads the committed text it writes.
   */
  async function capture(query: TurnInverseQuery): Promise<InverseCapture> {
    const createdDocuments = await createdDocumentsOf(query);
    const ids = await selectedDocuments(query);
    const parts: StoredInversePart[] = await history(ids);
    const partsByDocument = new Map<string, StoredInversePart[]>();
    for (const part of parts) {
      const list = partsByDocument.get(part.documentId);
      if (list) list.push(part);
      else partsByDocument.set(part.documentId, [part]);
    }
    const documents: InverseDocument[] = [];
    const removals = await input.removals.lookup(ids);
    try {
      for (const documentId of ids) {
        const removal = removals.get(documentId) ?? null;
        const availability = await input.fileAccess.destinationAvailability(
          { kind: "document", documentId },
          { kind: "live" },
        );
        // A delete keeps the document's bytes: its inverse plans over the retained history.
        const { doc: live, room: liveRoomName } = await materialize(documentId);
        await testHook("inverse.afterCaptureRead");
        documents.push({
          documentId,
          // A deleted document has no address: the model's path, or where it last stood.
          uri:
            (await input.resolveDocumentUri(documentId)) ??
            query.path ??
            (await input.resolveLastDocumentUri(documentId)) ??
            documentId,
          live,
          liveRoom: removal ? null : liveRoomName,
          removal,
          createdInTurn: createdDocuments.has(documentId),
          history: partsByDocument.get(documentId) ?? [],
          excerptView: null,
          destination: {
            kind: "live",
            view: live,
            closed: availability.closed,
            removed: removal !== null,
          },
        });
      }
    } catch (cause) {
      destroyDocuments(documents);
      throw cause;
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
    const captured = await capture(query);
    let result: T;
    try {
      result = await attemptStorage.run({ ...captured, deliveries }, () => run(captured.documents));
    } finally {
      destroyDocuments(captured.documents);
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
        await input.workProjection.ownersOf({ branches: tree.branches }),
        // The Works and chats whose notes the tree steps change.
        { workIds: tree.owners.works, lineageRootIds: tree.owners.lineages },
      );
      // Each document's own Work, which its write grant locks with the branch's.
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
    readHistory: (documentId) => history([documentId]),
    async describePart(document, part) {
      let excerpt = document.excerptView;
      if (!excerpt) {
        excerpt = new Y.Doc({ gc: false });
        Y.applyUpdate(excerpt, Y.encodeStateAsUpdate(document.live));
        document.excerptView = excerpt;
      }
      const [stored] = await db()
        .select({ update: documentEditParts.update })
        .from(documentEditParts)
        .where(eq(documentEditParts.id, part.id));
      if (!stored) throw new Error(`Edit part ${part.id} is gone`);
      Y.applyUpdate(excerpt, new Uint8Array(stored.update));
      const fragment = excerpt.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
      // Only the changed words, with `…` where other text sits between them in a block.
      const read = (ranges: ItemRanges) => textInRanges(fragment, ranges, { gap: " … " }).text;
      return {
        before: read(clockRanges(part.effect.deleted)),
        after: read(clockRanges(part.effect.inserted)),
      };
    },
    async commit({ plans, sequence, kind, userId, query }) {
      const attempt = attemptStorage.getStore();
      if (!attempt) throw new Error("An inverse commits only inside its captured attempt");
      await testHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with provenance on its attempt-local view.
      const planned = new Map(
        plans.map((plan): [PreparedDocumentInverse, PlannedInverse] => [
          plan,
          { plan, documentId: plan.document.documentId, updates: [], reversed: 0 },
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
        branches: tree.branches,
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
        for (const entry of documents) entry.live = (await materialize(entry.documentId)).doc;
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
        for (const entry of documents) entry.live?.destroy();
      }
      if (!admitted.ok) throw admitted.refusal;
      attempt.deliveries.push(...deliveries);
      return {
        handles,
        taken,
        updates: documents.flatMap((entry) => entry.updates),
        treeReversed,
        reversed: new Map(documents.map((entry) => [entry.documentId, entry.reversed])),
        cut: documents.length === 1 ? documents[0]?.cut : undefined,
      };
    },
  };

  async function admitInverse(
    sequence: readonly { plan: PreparedDocumentInverse; step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
    treeDocuments: readonly { documentId: string; branchId: DraftId | null; restore: boolean }[],
  ): Promise<{ grants: FileGrant<"edit">[] | null }> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
    // Every inverse supplies its principal explicitly; an absent one here means a composition
    // bug, not live routing.
    if (!principal) return { grants: null };
    const requirements = new Map<
      string,
      { documentId: DocumentId; branchId: DraftId | null; restore: boolean }
    >();
    for (const { plan } of sequence) {
      const documentId = plan.document.documentId;
      requirements.set(`${documentId}:live:content`, {
        documentId,
        branchId: null,
        restore: false,
      });
    }
    // A tree change is taken back where it was made, by the one who may edit that document; a
    // live document in Trash may only be restored.
    for (const { documentId, branchId, restore } of treeDocuments)
      requirements.set(`${documentId}:${branchId ?? "live"}:${restore ? "restore" : "content"}`, {
        documentId: documentId as DocumentId,
        branchId,
        restore,
      });
    const admittedRequirements = [...requirements.values()];
    const branchIds = [
      ...new Set(admittedRequirements.flatMap((r) => (r.branchId ? [r.branchId] : []))),
    ];
    const owner = draftOwnerSql(drafts.id);
    const holders = branchIds.length
      ? await db()
          .select({ draftId: drafts.id, handle: owner.handle })
          .from(drafts)
          .where(inArray(drafts.id, branchIds))
      : [];
    const byDraft = new Map(holders.map((holder) => [holder.draftId, holder]));
    const grants: FileGrant<"edit">[] = [];
    for (const requirement of admittedRequirements) {
      const holder = requirement.branchId ? byDraft.get(requirement.branchId) : undefined;
      // A tree change's draft purged since restarts the command.
      if (requirement.branchId && !holder) throw new TreeOwnersMoved();
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
   * One step inside the commit scope: each of its changes that still stands in Live is taken out
   * by content, and one receipt of kind `undo` or `revert` names the parts it took, with the
   * model's chat and write ordinal or the writer. A change that stopped standing between the
   * capture and the lock is left whole.
   */
  async function commitStep(
    entry: PlannedInverse,
    step: InverseStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<{ handle: string; parts: number }> {
    const { documentId } = entry;
    const live = entry.live;
    if (!live) throw new Error("A step runs inside the commit scope");
    const fragment = live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    const back = takeBack(readBlocks(fragment, inverseSchema), step.parts);
    if (!back.taken.length) return { handle: "", parts: 0 };
    // The receipts are read against Live as it was before the write.
    const before = new Y.Doc({ gc: false });
    Y.applyUpdate(before, Y.encodeStateAsUpdate(live));
    const written = captureMutationUpdates(live, () =>
      live.transact(() => writeBlocks(fragment, inverseSchema, back.live), "inverse"),
    );
    // The model's echo shows Live around its Undo.
    const beforeState = query.model ? Y.encodeStateAsUpdate(before) : null;
    const receipts: ReceiptWrite["receipts"] = [];
    const targets = back.taken.map((part) => ({ editId: part.editId, ordinal: part.ordinal }));
    try {
      for (const update of written) {
        const seq = await input.journal.append(documentId, update, {
          origin: query.model && query.turnId ? `agent:${query.turnId}` : "system",
          ...(query.model && query.turnId ? { actorTurnId: query.turnId } : {}),
          seq: 0,
        });
        entry.updates.push(update);
        for (const receipt of captureReceiptRows(
          before,
          [{ update, origin: { kind: "live", seq } }],
          // The model's Undo is an edit on its stack, which a later Undo or revert reads back.
          !!query.model,
        ))
          receipts.push({ ...receipt, targets });
      }
    } finally {
      before.destroy();
    }
    if (beforeState) entry.cut = { before: beforeState, after: Y.encodeStateAsUpdate(live) };
    // The model's inverse is an edit on its stack: it takes the next write ordinal, as a write does.
    const wId = query.model
      ? await input.journal.reserveWriteOrdinal(documentId, query.threadId)
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
    entry.reversed += back.taken.length;
    return {
      handle: wId === undefined ? "" : editHandle(wId),
      parts: back.taken.length,
    };
  }

  /** After every step: the document's delivery. */
  async function settleDocument(
    entry: PlannedInverse,
    kind: "undo" | "revert",
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<void> {
    if (!entry.updates.length) return;
    const { documentId } = entry;
    deliveries.push(async () => {
      await input.coordinator.deliver(documentId);
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
  const treeHistory = createDrizzleTreeHistory(input.db, input.journal, (threadId, documentId) =>
    service.modelStack(documentId as DocumentId, threadId),
  );
  return service;
}

/** What a commit builds up for one document: what its steps wrote, for delivery and the answer. */
type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: DocumentId;
  /** Live's journal updates the steps wrote. */
  updates: Uint8Array[];
  /** Live as the commit scope found it, which the steps write through. */
  live?: Y.Doc;
  /** The cuts around the model's Undo, for its echo. */
  cut?: { before: Uint8Array; after: Uint8Array };
  /** Text parts the steps took. */
  reversed: number;
};

type InverseCapture = {
  ids: DocumentId[];
  documents: InverseDocument[];
};

function clockRanges(
  ranges: readonly { client: number; clock: number; len: number }[],
): ItemRanges {
  const clients = new Map<number, { clock: number; len: number }[]>();
  for (const { client, clock, len } of ranges) {
    const list = clients.get(client) ?? [];
    list.push({ clock, len });
    clients.set(client, list);
  }
  return { clients };
}

/** The attempt a store call runs in: its capture, and the deliveries that wait for its commit. */
const attemptStorage = new AsyncLocalStorage<
  InverseCapture & { deliveries: (() => Promise<void>)[] }
>();

function destroyDocuments(documents: readonly InverseDocument[]): void {
  for (const document of documents) {
    document.excerptView?.destroy();
    document.live.destroy();
  }
}
