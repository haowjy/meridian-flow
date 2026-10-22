/**
 * Durable multi-document inverse admission: a lock-free capture, a plan on attempt-local
 * documents, one commit scope that validates the capture; delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ComputedInverseEdit,
  editHandle,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates, textInRanges } from "@meridian/agent-edit/yjs-mutation";
import {
  type BranchId,
  type BranchTreeFacts,
  type DocumentId,
  isLiveTransition,
  type LiveTreeTransition,
  type TreeChangeOp,
  type TreePlacement,
  type UserId,
} from "@meridian/contracts";
import type { TurnInverseSkip } from "@meridian/contracts/protocol";
import {
  type Database,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  draftWriteJournal,
  type EditOrigin,
  works,
} from "@meridian/database";
import { branchTreeChanges } from "@meridian/database/schema";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import {
  moveToPlacement,
  placementSources,
  readLiveTreeStates,
} from "../../context/tree/live-tree-state.js";
import { acquireTreeScope, TreeScopeChangedError } from "../../context/tree/mutation-scope.js";
import { readRemovalRecords, restoreDocument } from "../../context/tree/removal.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { type Attempt, runBoundedAttempts } from "../domain/draft-attempts.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import {
  createDraftDispositionReader,
  type DraftDispositionView,
} from "../domain/draft-disposition.js";
import { type DraftStore, materializeDraftRead } from "../domain/draft-store.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import { ReversalConflictError } from "../domain/reversal-conflict.js";
import {
  type PlannedTreeInverse,
  type StoredTreeEntry,
  sameBranchFacts,
  sameLiveState,
  type TreeInverseFault,
  TreeInverseRefused,
  type TreeStates,
  treeFaultReason,
} from "../domain/tree-inverse.js";
import {
  createTurnInverseService,
  type InverseDocument,
  type PreparedDocumentInverse,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { nextEditSeq, recordDocumentEdit } from "./drizzle-document-edits.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";
import { commitRewriteWithinTx, insertJournalRows } from "./drizzle-draft-storage.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";

type Dependencies = {
  db: Database;
  journal: UpdateJournal;
  drafts: DraftStore;
  coordinator: LiveDocumentCoordinator;
  draftCoordinator: Pick<DraftCoordinator, "deliverCommitted">;
  onDraftCommitted(draftId: string): void;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  flushLivePull(documentId: DocumentId): Promise<void>;
  notices: import("../domain/reversal-notices.js").TurnInverseNoticePort;
  /** Revert and rollback change pending membership, so they reconcile the Works' counts through it. */
  workProjection: Pick<WorkProjectionMutation, "mutate">;
  /** A delete's redo removes the document again; its undo restores it (`restoreDocument`). */
  removal: DocumentRemoval;
  arrivals?: Pick<DocumentArrivals, "settle">;
  catalog: Pick<ContextCatalogMutationPort, "refreshSources">;
};
export function createDrizzleTurnInverseService(input: Dependencies) {
  const db = () => currentDrizzleDb(input.db);
  const readDisposition = createDraftDispositionReader(
    createDrizzleDraftDispositionStore(input.db),
  );
  async function selectedDocuments(query: TurnInverseQuery): Promise<DocumentId[]> {
    if (query.model) return [...new Set(query.documentIds ?? [])].sort();
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
          update: documentEditParts.update,
          effect: documentEditParts.effect,
          targets: documentEditParts.targets,
          frontier: documentEditParts.frontier,
          aliases: documentEditParts.aliases,
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
      update: new Uint8Array(part.update),
      kind: edit.kind,
      actionId: edit.actionId,
      documentId: edit.documentId,
      threadId: edit.threadId,
      turnId: edit.turnId,
      responseId: edit.responseId,
      editScopeId: edit.editScopeId,
      consumes: edit.consumes,
      actor: edit.actor,
      wId: edit.wId,
    }));
  }
  /** Each document's tree entries, ordered by `seq` on the parts' axis. */
  async function treeHistory(documentIds: DocumentId[]): Promise<StoredTreeEntry[]> {
    if (!documentIds.length) return [];
    const rows = await db()
      .select()
      .from(documentEdits)
      .where(
        and(inArray(documentEdits.documentId, documentIds), isNotNull(documentEdits.treeChange)),
      );
    return rows
      .flatMap((edit) =>
        edit.treeChange
          ? [
              {
                id: edit.treeChange.seq,
                editId: edit.id,
                documentId: edit.documentId,
                threadId: edit.threadId,
                turnId: edit.turnId,
                responseId: edit.responseId,
                editScopeId: edit.editScopeId,
                actor: edit.actor,
                wId: edit.wId,
                kind: edit.kind,
                actionId: edit.actionId,
                consumes: edit.consumes,
                targets: edit.treeChange.targets,
                tree: edit.treeChange,
              },
            ]
          : [],
      )
      .sort((a, b) => a.id - b.id);
  }
  /** What each document's tree destinations hold now: live, and every branch an entry names. */
  async function treeStates(
    documentIds: DocumentId[],
    tree: readonly StoredTreeEntry[],
  ): Promise<Map<DocumentId, TreeStates>> {
    const live = await readLiveTreeStates(db(), documentIds);
    const named = [
      ...new Set(
        tree.flatMap((row) =>
          row.tree.destination.kind === "draft" ? [row.tree.destination.branchId] : [],
        ),
      ),
    ];
    const rows = named.length
      ? await db()
          .select({
            branchId: branchTreeChanges.branchId,
            nodeId: branchTreeChanges.nodeId,
            created: branchTreeChanges.created,
          })
          .from(branchTreeChanges)
          .where(
            and(
              eq(branchTreeChanges.nodeKind, "document"),
              inArray(branchTreeChanges.nodeId, documentIds),
              inArray(branchTreeChanges.branchId, named),
            ),
          )
      : [];
    return new Map(
      documentIds.map((documentId) => {
        const branches = new Map<BranchId, BranchTreeFacts>();
        for (const branchId of named) {
          const row = rows.find((r) => r.branchId === branchId && r.nodeId === documentId);
          branches.set(branchId as BranchId, {
            row: row !== undefined,
            created: row?.created ?? false,
            moved: null,
            deleted: false,
          });
        }
        return [documentId, { live: live.get(documentId) ?? null, branches }];
      }),
    );
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
  /** Historical origin drafts supply disposition; only active drafts below admit writes. */
  function inverseDraftIds(
    query: TurnInverseQuery,
    parts: readonly { origin: EditOrigin }[],
  ): string[] {
    return [
      ...new Set([
        ...(query.draftId ? [query.draftId] : []),
        ...parts.flatMap((part) => (part.origin.kind === "pending" ? [part.origin.draftId] : [])),
      ]),
    ].sort();
  }

  /**
   * One read-only snapshot of every affected document: live at its head, each draft at its
   * revision without merging live identity, the history,
   * and each draft's Work lifecycle from its row. No lock of any kind.
   */
  async function capture(query: TurnInverseQuery): Promise<InverseCapture> {
    const captured = await runInRootDrizzleReadSnapshot(input.db, async () => {
      const ids = await selectedDocuments(query);
      const rows = await history(ids);
      const tree = await treeHistory(ids);
      const states = await treeStates(ids, tree);
      const draftIds = inverseDraftIds(query, rows);
      const parts: StoredInversePart[] = rows.map((part) => ({
        ...part,
        disposition: "pending",
      }));
      const documents: InverseDocument[] = [];
      const heads = new Map<DocumentId, number>();
      const removals = await readRemovalRecords(db(), ids);
      try {
        for (const documentId of ids) {
          const removal = removals.get(documentId) ?? null;
          // A discard released the document's bytes; a delete kept them, and its drafts that
          // outlived it (D79) plan their inverse over the retained live history.
          const released = removal?.reason === "discarded";
          const { doc: live, room: liveRoomName } = released
            ? { doc: new Y.Doc({ gc: false }), room: null }
            : await materialize(documentId);
          const [head] = await db()
            .select({ id: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)::bigint` })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.documentId, documentId));
          heads.set(documentId, Number(head?.id ?? 0));
          const documentTree = tree.filter((row) => row.documentId === documentId);
          const document: InverseDocument = {
            documentId,
            // A deleted document has no address: the model's path, or where it last stood.
            uri:
              (await input.resolveDocumentUri(documentId)) ??
              query.path ??
              [...documentTree].reverse().find((row) => row.tree.shownAt)?.tree.shownAt ??
              documentId,
            live,
            liveRoom: removal ? null : liveRoomName,
            removal,
            history: parts.filter((part) => part.documentId === documentId),
            tree: documentTree,
            treeStates: states.get(documentId) ?? { live: null, branches: new Map() },
            drafts: new Map(),
          };
          documents.push(document);
          const drafts = new Map<
            string,
            InverseDocument["drafts"] extends ReadonlyMap<string, infer D> ? D : never
          >();
          for (const draftId of released ? [] : draftIds) {
            const read = await input.drafts.readDraftAt(draftId);
            const documentDraft = read?.documentDraft;
            if (
              !read ||
              documentDraft?.documentId !== documentId ||
              documentDraft.status !== "active"
            )
              continue;
            const doc = materializeDraftRead(read, new Y.Doc({ gc: false }));
            const [name] = documentDraft.workId
              ? await db()
                  .select({ handle: works.handle })
                  .from(works)
                  .where(eq(works.id, documentDraft.workId))
              : [];
            drafts.set(draftId, {
              documentDraft,
              doc,
              name: name?.handle ?? "No Work",
              frozen: documentDraft.lifecycle !== "active",
            });
          }
          document.drafts = drafts;
        }
      } catch (cause) {
        destroyDocuments(documents);
        throw cause;
      }
      return { ids, draftIds, documents, heads };
    });
    // The reader owns its own root snapshot. Do not nest it inside the capture above:
    // a single-connection caller would wait forever for its own read connection.
    try {
      const views = new Map<string, DraftDispositionView | null>();
      for (const draftId of captured.draftIds) views.set(draftId, await readDisposition(draftId));
      const byPart = new Map<string, StoredInversePart["disposition"]>();
      for (const view of views.values())
        for (const part of view?.parts ?? [])
          byPart.set(`${part.editId}:${part.ordinal}`, part.disposition);
      for (const document of captured.documents) {
        for (const [draftId, draft] of document.drafts) {
          const evidence = views.get(draftId);
          if (!evidence || evidence.draft.revision !== draft.documentDraft.revision)
            throw new InverseAttemptMiss();
        }
        document.history = document.history.map((part) => ({
          ...part,
          disposition:
            part.origin.kind === "live"
              ? "pending"
              : (byPart.get(`${part.editId}:${part.ordinal}`) ??
                (part.actor !== "agent" && views.get(part.origin.draftId)?.draft.status === "active"
                  ? "pending"
                  : "discarded")),
        }));
      }
      return captured;
    } catch (cause) {
      destroyDocuments(captured.documents);
      throw cause;
    }
  }

  /**
   * An inverse's attempts (section 2.4): capture, plan, then one commit scope that validates
   * every captured draft revision and live head; a miss unwinds the whole attempt and
   * recaptures. After four commit attempts one more capture is planned without writing: a
   * plan with nothing applicable answers with its own reasons, one that still applies is a
   * conflict (`ReversalConflictError`), never success and never an invented refusal.
   */
  async function attempts<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
  ): Promise<T> {
    return runBoundedAttempts({
      bound: INVERSE_ATTEMPTS,
      scope: (operation) => runInDrizzleSavepoint(input.db, operation),
      isMiss: (cause) => cause instanceof InverseAttemptMiss,
      run: (attempt) => capturedAttempt(query, run, attempt),
      exhausted: () => capturedAttempt(query, run, null),
    });
  }

  /** One capture planned by `run`; with no `attempt`, the classification pass that never writes. */
  async function capturedAttempt<T>(
    query: TurnInverseQuery,
    run: (documents: InverseDocument[]) => Promise<T>,
    attempt: Attempt | null,
  ): Promise<T> {
    const deliveries: (() => Promise<void>)[] = [];
    // Delivery reads the documents through their coordinators and may pull: only once the
    // attempt completed, and outside every mutex it held.
    attempt?.own({
      async transfer() {
        const deliver = async () => {
          for (const delivery of deliveries) await delivery();
        };
        if (!deferUntilDrizzleCommit(deliver)) await deliver();
      },
      dispose() {},
    });
    // Nothing is held: a rewrite that lands between this capture and the commit moves a captured
    // revision or live head, which the commit scope finds and turns into a whole-attempt miss.
    let captured: InverseCapture;
    try {
      captured = await capture(query);
    } catch (cause) {
      if (!attempt && cause instanceof InverseAttemptMiss) throw new ReversalConflictError();
      throw cause;
    }
    try {
      return await attemptStorage.run({ ...captured, attempt, deliveries }, () =>
        run(captured.documents),
      );
    } finally {
      destroyDocuments(captured.documents);
    }
  }

  const store: TurnInverseStore = {
    withCapturedDocuments: attempts,
    describePart(document, part) {
      const doc =
        part.origin.kind === "pending"
          ? (document.drafts.get(part.origin.draftId)?.doc ?? document.live)
          : document.live;
      const own = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(own, Y.encodeStateAsUpdate(doc));
        Y.applyUpdate(own, part.update);
        return {
          before: textInRanges(own, part.effect.deleted),
          after: textInRanges(own, part.effect.inserted),
        };
      } finally {
        own.destroy();
      }
    },
    async commit({ plans, kind, userId, query }) {
      const attempt = attemptStorage.getStore();
      if (!attempt) throw new Error("An inverse commits only inside its captured attempt");
      if (!attempt.attempt) throw new ReversalConflictError();
      const scope = attempt.attempt;
      await testHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with provenance on its attempt-local view.
      const planned = plans.map((plan) => planDocument(plan, query));
      const liveIds = planned.filter((entry) => !entry.draft).map((entry) => entry.documentId);
      const handles: string[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      const treeRuns = orderTreeRuns(plans, kind, query);
      const treeSkips: TurnInverseSkip[] = [];
      await withLiveDocuments([...new Set(liveIds)].sort(), () =>
        scope.commit(() =>
          // A seam boundary before any other lock (decision D17, file-access §5): the captured
          // drafts' Works and the bound grants' Works in one id order, the grants confirmed,
          // then the documents' mutation locks, then the rows. A live-only inverse (a named
          // Work's Scratch) captures no draft, so its Work is locked only as a grant Work. Two
          // inverses are ordered by what they captured, not by a lock of their own: a draft's
          // exact checkpoint revision and a live head checked under the document lock (D22).
          input.workProjection.mutate(
            { drafts: attempt.draftIds },
            async () => {
              if (treeRuns.length) await lockTreeScope(treeRuns, attempt.ids);
              else for (const id of [...attempt.ids].sort()) await lockDocumentMutation(db(), id);
              // The live state each plan was computed against is still the head.
              for (const entry of planned) {
                if (entry.draft) continue;
                const [head] = await db()
                  .select({ id: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)::bigint` })
                  .from(documentYjsUpdates)
                  .where(eq(documentYjsUpdates.documentId, entry.documentId));
                if (Number(head?.id ?? 0) !== attempt.heads.get(entry.documentId))
                  throw new InverseAttemptMiss();
              }
              // Moves and deletes first: text lands in a document its restore brought back.
              for (const run of treeRuns) {
                const outcome = await commitTreeInverse(run, kind, userId, query);
                if (typeof outcome === "string") handles.push(outcome);
                else treeSkips.push(outcome);
              }
              for (const entry of planned)
                handles.push(...(await commitDocument(entry, kind, userId, query, deliveries)));
            },
            { seam: true },
          ),
        ),
      );
      attempt.deliveries.push(...deliveries);
      return { handles, updates: planned.flatMap((entry) => entry.updates), treeSkips };
    },
  };

  /**
   * The namespaces of every source the tree inverses touch (where the documents are, and the
   * placements they return to), then every document lock of the attempt, then the captured
   * tree states checked again: a document that moved or was removed since is a miss.
   */
  async function lockTreeScope(runs: readonly TreeRun[], ids: readonly DocumentId[]) {
    const placements = runs.flatMap(({ planned }): TreePlacement[] =>
      isLiveTransition(planned)
        ? [planned.before, planned.after].flatMap((state) => (state.living ? [state.at] : []))
        : [],
    );
    try {
      await acquireTreeScope(input.db, { documentIds: [...ids], placements });
    } catch (cause) {
      if (cause instanceof TreeScopeChangedError) throw new InverseAttemptMiss();
      throw cause;
    }
    const documents = [...new Set(runs.map((run) => run.document))];
    const now = await treeStates(
      documents.map((document) => document.documentId),
      documents.flatMap((document) => document.tree),
    );
    for (const document of documents) {
      const current = now.get(document.documentId);
      const captured = document.treeStates;
      if (
        !current ||
        (current.live !== captured.live && !sameLiveState(current.live, captured.live)) ||
        [...captured.branches].some(
          ([branchId, facts]) => !sameBranchFacts(current.branches.get(branchId), facts),
        )
      )
        throw new InverseAttemptMiss();
    }
  }

  /**
   * One tree inverse, isolated in a savepoint: the live move, restore or delete, then its row.
   * A destination that can't take it refuses a model inverse whole, and is a reported skip for
   * the card and a rollback, whose other inverses still run. Returns the model's handle.
   */
  async function commitTreeInverse(
    run: TreeRun,
    kind: "undo" | "redo" | "revert" | "rollback",
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string | TurnInverseSkip> {
    const { document, plan, planned } = run;
    const documentId = document.documentId;
    try {
      return await runInDrizzleSavepoint(input.db, async () => {
        if (!isLiveTransition(planned))
          // Drafted tree entries are written only by drafted placement, which brings their inverse.
          throw new Error("A drafted tree entry has no inverse yet");
        const [before] = (await readLiveTreeStates(db(), [documentId])).values();
        if (!sameLiveState(before, planned.before)) throw new TreeFault("superseded");
        const fault = await applyLiveTreeInverse(documentId, planned.op, planned, userId);
        if (fault) throw new TreeFault(fault);
        const [after] = (await readLiveTreeStates(db(), [documentId])).values();
        if (!after) throw new Error(`Tree inverse left ${documentId} hidden`);
        const wId = query.model
          ? await input.journal.reserveWriteOrdinal(documentId, query.threadId)
          : undefined;
        await recordDocumentEdit(db(), {
          documentId,
          actor: query.model ? "agent" : kind === "rollback" ? "system" : "human",
          wId,
          threadId: query.model ? query.threadId : undefined,
          turnId: query.model ? query.turnId : undefined,
          responseId: query.model ? query.responseIdentity?.providerResponseId : undefined,
          editScopeId: query.model ? query.responseIdentity?.editScopeId : undefined,
          actorUserId: userId,
          kind,
          actionId: planned.actionId ?? plan.computed.actionId,
          consumes: plan.consumes,
          receipts: [],
          treeChange: {
            op: planned.op,
            destination: planned.destination,
            before: planned.before,
            after,
            shownAt: document.uri,
            seq: await nextEditSeq(db()),
            targets: [{ editId: planned.entry.editId, direction: planned.direction }],
          },
        });
        return wId === undefined ? "" : editHandle(wId);
      });
    } catch (cause) {
      if (!(cause instanceof TreeFault)) throw cause;
      if (query.model)
        throw new TreeInverseRefused(cause.fault, planned, planned.entry.tree.shownAt ?? undefined);
      return {
        documentId,
        uri: document.uri,
        before: planned.entry.tree.shownAt ?? "",
        after: "",
        reason: treeFaultReason(cause.fault),
      };
    }
  }

  /**
   * The live operation a planned inverse makes; a fault when the destination can't take it. The
   * history writer checked each recorded transition's endpoints against its op.
   */
  async function applyLiveTreeInverse(
    documentId: DocumentId,
    op: TreeChangeOp,
    { before, after }: Pick<LiveTreeTransition, "before" | "after">,
    userId: UserId | undefined,
  ): Promise<TreeInverseFault | null> {
    const deps = { arrivals: input.arrivals, catalog: input.catalog };
    switch (op) {
      case "move": {
        if (!before.living || !after.living) throw new Error("A move inverse joins two placements");
        const moved = await moveToPlacement(
          input.db,
          { documentId, from: before.at, to: after.at },
          deps,
        );
        return moved.kind === "moved" ? null : moved.kind;
      }
      case "restore": {
        if (before.living) throw new Error("A restore inverse starts from a removal");
        const restored = await restoreDocument(
          input.db,
          {
            documentId,
            removal: {
              time: new Date(before.removal.time),
              locationVersion: BigInt(before.removal.locationVersion),
            },
          },
          deps,
        );
        if (restored.kind === "restored") return null;
        return restored.kind === "already_living" ? "superseded" : restored.kind;
      }
      case "delete": {
        if (!before.living) throw new Error("A delete inverse starts from a placement");
        await input.removal.remove({ documentIds: [documentId], reason: "deleted", userId });
        const [source] = await placementSources(input.db, [before.at]);
        await input.catalog.refreshSources(source ? [source] : [], [documentId]);
        return null;
      }
    }
  }

  /** Each part of a plan applied to its view with its restoration provenance; no I/O. */
  function planDocument(plan: PreparedDocumentInverse, query: TurnInverseQuery): PlannedInverse {
    const document = plan.document;
    const draftEntry = plan.draftId ? document.drafts.get(plan.draftId) : undefined;
    const view = draftEntry?.doc ?? document.live;
    const edits = plan.computed.edits.map((edit) => ({
      edit,
      parts: edit.parts.map((computedPart) => {
        const client =
          Y.decodeUpdate(computedPart.update).structs[0]?.id.client ?? allocateDocumentClient(view);
        const provenance = captureMutationUpdates(view, () => {
          view.transact(() => {
            Y.applyUpdate(view, computedPart.update);
            const planningClient = view.clientID;
            view.clientID = client;
            try {
              appendInverseRestorationFacts(view, computedPart.aliases);
            } finally {
              view.clientID = planningClient;
            }
          });
        });
        return {
          ...computedPart,
          update: provenance.length
            ? Y.mergeUpdates([computedPart.update, ...provenance])
            : computedPart.update,
        };
      }),
    }));
    const updates = edits.flatMap((entry) => entry.parts.map((part) => part.update));
    return {
      plan,
      documentId: document.documentId,
      edits,
      updates,
      draft: draftEntry
        ? {
            draftId: draftEntry.documentDraft.draftId,
            revision: draftEntry.documentDraft.revision,
            view,
          }
        : undefined,
      source: query.model ? "agent" : "writer",
    };
  }

  /** One planned document inside the commit scope: its rows, receipts, statuses, delivery. */
  async function commitDocument(
    entry: PlannedInverse,
    kind: "undo" | "redo" | "revert" | "rollback",
    userId: UserId | undefined,
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<string[]> {
    const { plan, draft } = entry;
    const document = plan.document;
    const handles: string[] = [];
    const origins: EditOrigin[][] = entry.edits.map(() => []);
    if (draft && entry.updates.length) {
      // Shape (a): the captured draft plus the inverse parts, written whole as the
      // checkpoint at the revision it was captured at; the rows are inserted under the row
      // lock, inside the checkpoint they belong to.
      const rewritten = await commitRewriteWithinTx(db(), {
        draftId: draft.draftId,
        policy: { kind: "exact", revision: draft.revision },
        work: "active",
        doc: draft.view,
        withinLock: async () => {
          const updateMeta = (
            aliases: (typeof entry.edits)[number]["parts"][number]["aliases"],
          ) => ({
            ...(query.model && query.responseIdentity
              ? {
                  authoringResponseId: query.responseIdentity.providerResponseId,
                  editScopeId: query.responseIdentity.editScopeId,
                }
              : {}),
            restorationAliases: aliases.map((alias) => ({
              source: { ...alias.source, length: alias.len },
              target: { ...alias.target, length: alias.len },
            })),
          });
          const edits = entry.edits.flatMap(({ parts }, index) =>
            parts.map((part) => ({ index, part })),
          );
          const rowIds = await insertJournalRows(
            db(),
            edits.map(({ part }) => ({
              draftId: draft.draftId,
              updateData: part.update,
              source: entry.source,
              threadId: query.model ? query.threadId : null,
              turnId: query.model ? query.turnId : null,
              actorUserId: userId ?? null,
              updateMeta: updateMeta(part.aliases),
            })),
          );
          for (const [position, { index }] of edits.entries()) {
            const rowId = rowIds[position];
            if (rowId === undefined) throw new Error("Inverse journal was not inserted");
            origins[index].push({
              kind: "pending",
              draftId: draft.draftId,
              rowId,
            });
          }
        },
      });
      if (rewritten.status !== "committed") throw new InverseAttemptMiss();
    } else if (!draft) {
      for (const [index, { parts }] of entry.edits.entries())
        for (const part of parts) {
          const seq = await input.journal.append(document.documentId, part.update, {
            // Inverse receipts are captured below; a human journal origin
            // would also capture a second, ordinary writer receipt.
            origin: query.model && query.turnId ? `agent:${query.turnId}` : "system",
            ...(query.model && query.turnId ? { actorTurnId: query.turnId } : {}),
            ...(query.model && query.responseIdentity
              ? {
                  authoringResponseId: query.responseIdentity.providerResponseId,
                  editScopeId: query.responseIdentity.editScopeId,
                }
              : {}),
            seq: 0,
          });
          origins[index].push({ kind: "live", seq });
        }
    }
    for (const [index, { edit, parts }] of entry.edits.entries()) {
      const receipts = parts.map((part, ordinal) => ({ ...part, origin: origins[index][ordinal] }));
      const wId = query.model
        ? await input.journal.reserveWriteOrdinal(document.documentId, query.threadId)
        : undefined;
      if (wId !== undefined) {
        handles.push(editHandle(wId));
        for (const receipt of receipts)
          if (receipt.origin.kind === "pending")
            await db()
              .update(draftWriteJournal)
              .set({ wId })
              .where(eq(draftWriteJournal.id, receipt.origin.rowId));
      }
      await recordDocumentEdit(db(), {
        documentId: document.documentId,
        actor: query.model ? "agent" : kind === "rollback" ? "system" : "human",
        wId,
        threadId: query.model ? query.threadId : undefined,
        turnId: query.model ? query.turnId : undefined,
        responseId: query.model ? query.responseIdentity?.providerResponseId : undefined,
        editScopeId: query.model ? query.responseIdentity?.editScopeId : undefined,
        actorUserId: userId,
        kind,
        actionId: edit.actionId ?? plan.computed.actionId,
        consumes: plan.consumes,
        receipts,
      });
    }
    if (kind === "rollback") {
      const accepted = new Set(
        plan.computed.edits.flatMap((edit) =>
          edit.parts.flatMap((part) =>
            part.targets.map((target) => `${target.editId}:${target.ordinal}`),
          ),
        ),
      );
      const unresolved = document.history.filter(
        (part) =>
          (part.kind === "write" ||
            part.kind === "revert" ||
            part.kind === "undo" ||
            part.kind === "redo") &&
          part.editScopeId === query.responseIdentity?.editScopeId &&
          part.origin.kind === "pending" &&
          part.disposition === "pending" &&
          !accepted.has(`${part.editId}:${part.ordinal}`) &&
          !document.history.some(
            (transition) =>
              transition.kind === "rollback" &&
              transition.targets.some(
                (target) => target.editId === part.editId && target.ordinal === part.ordinal,
              ),
          ),
      );
      const rowIds = unresolved.flatMap((part) =>
        part.origin.kind === "pending" ? [part.origin.rowId] : [],
      );
      if (rowIds.length) {
        await db()
          .update(draftWriteJournal)
          .set({ status: "rollback_pending" })
          .where(
            and(inArray(draftWriteJournal.id, rowIds), eq(draftWriteJournal.status, "active")),
          );
      }
    }
    if (!entry.updates.length) return handles;
    const deliver = async () => {
      if (draft) {
        input.onDraftCommitted(draft.draftId);
        await input.draftCoordinator.deliverCommitted(draft.draftId);
      } else {
        await input.coordinator.deliver(document.documentId);
        await input.refreshDocument(document.documentId);
        await input.flushLivePull(document.documentId);
      }
      if (kind !== "rollback" && kind !== "revert" && !query.model && query.turnId)
        await input.notices.record({
          docId: document.documentId,
          threadId: query.threadId,
          direction: kind,
          turnId: query.turnId,
          sweptContent: false,
          beforeContentRef: null,
        });
    };
    deliveries.push(deliver);
    return handles;
  }

  /** The live documents' coordinator mutexes, sorted, around the commit scope only (live scope). */
  async function withLiveDocuments<T>(ids: readonly string[], run: () => Promise<T>): Promise<T> {
    const enter = async (index: number): Promise<T> => {
      const id = ids[index];
      return id ? input.coordinator.withDocument(id, () => enter(index + 1)) : run();
    };
    return enter(0);
  }

  return createTurnInverseService(store);
}

/** One tree inverse with its plan and document, in the order the commit runs it. */
type TreeRun = {
  plan: PreparedDocumentInverse;
  document: InverseDocument;
  planned: PlannedTreeInverse;
};

/**
 * The model's planned order stands (its steps simulate one after another); the card and a
 * rollback reverse across documents newest first, and redo oldest first, so a renumber
 * undone never meets a location it vacated later.
 */
function orderTreeRuns(
  plans: readonly PreparedDocumentInverse[],
  kind: "undo" | "redo" | "revert" | "rollback",
  query: TurnInverseQuery,
): TreeRun[] {
  const runs = plans.flatMap((plan) =>
    plan.tree.map((planned) => ({ plan, document: plan.document, planned })),
  );
  if (query.model) return runs;
  return runs.sort((a, b) =>
    kind === "redo"
      ? a.planned.entry.id - b.planned.entry.id
      : b.planned.entry.id - a.planned.entry.id,
  );
}

/** A tree inverse the destination refused under the locks; its savepoint rolls back. */
class TreeFault extends Error {
  constructor(readonly fault: TreeInverseFault) {
    super(`Tree inverse refused: ${fault}`);
    this.name = "TreeFault";
  }
}

/** A commit attempt of an inverse: four, then one classification pass (section 2.4, F5). */
const INVERSE_ATTEMPTS = 4;

type InverseCapture = {
  ids: DocumentId[];
  draftIds: string[];
  documents: InverseDocument[];
  /** Each document's live head (`max(document_yjs_updates.id)`) at the capture. */
  heads: Map<DocumentId, number>;
};

type PlannedInverse = {
  plan: PreparedDocumentInverse;
  documentId: DocumentId;
  edits: { edit: ComputedInverseEdit; parts: ComputedInverseEdit["parts"][number][] }[];
  updates: Uint8Array[];
  draft?: {
    draftId: string;
    revision: number;
    view: Y.Doc;
  };
  source: "agent" | "writer";
};

/** The attempt a store call runs in: its capture, and whether it may still commit. */
const attemptStorage = new AsyncLocalStorage<
  InverseCapture & { attempt: Attempt | null; deliveries: (() => Promise<void>)[] }
>();

/** The captured revision or live head moved before the commit scope validated it. */
class InverseAttemptMiss extends Error {
  constructor() {
    super("The inverse's captured documents changed before it committed");
    this.name = "InverseAttemptMiss";
  }
}

function destroyDocuments(documents: readonly InverseDocument[]): void {
  for (const document of documents) {
    document.live.destroy();
    for (const draft of document.drafts.values()) draft.doc.destroy();
  }
}
