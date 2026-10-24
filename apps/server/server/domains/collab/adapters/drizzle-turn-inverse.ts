/**
 * Durable multi-document inverse admission: a lock-free capture, a plan on attempt-local
 * documents, one commit scope that validates the capture; delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { editHandle, type UpdateJournal } from "@meridian/agent-edit/integration";
import { textInRanges } from "@meridian/agent-edit/yjs-mutation";
import {
  type BranchId,
  type BranchTreeFacts,
  type DocumentId,
  type FolderId,
  isLiveTransition,
  type TreePlacement,
  type TreeTransition,
  type TreeTransitionChange,
  type UserId,
} from "@meridian/contracts";
import type { TurnInverseSkip } from "@meridian/contracts/protocol";
import {
  branches,
  type Database,
  documentDrafts,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  draftWriteJournal,
  type EditOrigin,
  works,
} from "@meridian/database";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { nextEditSeq } from "../../../shared/edit-history-seq.js";
import { testHook } from "../../../shared/test-hooks.js";
import { runTreeEditAdmission } from "../../context/context/tree-edit-admission.js";
import type { ContextCatalogMutationPort } from "../../context/ports/context-catalog.js";
import type { DocumentArrivals } from "../../context/ports/document-arrivals.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { readBranchTreeFacts } from "../../context/tree/branch-tree-store.js";
import { resolveAbsorbedFolders } from "../../context/tree/folder-normalization.js";
import { readLiveTreeStates } from "../../context/tree/live-tree-state.js";
import { TreeScopeChangedError, type TreeScopeRequest } from "../../context/tree/mutation-scope.js";
import { readRemovalRecords } from "../../context/tree/removal.js";
import {
  type FileAccess,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
  runWithEditGrants,
} from "../../file-policy/index.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { type Attempt, runBoundedAttempts } from "../domain/draft-attempts.js";
import type { DraftCoordinator } from "../domain/draft-coordinator.js";
import {
  createDraftDispositionReader,
  type DraftDispositionView,
} from "../domain/draft-disposition.js";
import { type DraftStore, materializeDraftRead } from "../domain/draft-store.js";
import { createInverseDestinationResolver } from "../domain/inverse-draft-destination.js";
import type { InverseStep } from "../domain/inverse-stream.js";
import { liveRoom } from "../domain/observation-rooms.js";
import type { LiveDocumentCoordinator } from "../domain/ports/live-document-coordinator.js";
import { ReversalConflictError } from "../domain/reversal-conflict.js";
import {
  isTransitionEntry,
  type PlannedTreeInverse,
  type StoredTreeEntry,
  sameBranchFacts,
  sameLiveState,
  TreeInverseRefused,
  type TreeStates,
  treeChangeFolders,
  withCurrentFolders,
} from "../domain/tree-inverse.js";
import {
  type CommittedTreeLanding,
  createTurnInverseService,
  type InverseDocument,
  type PreparedDocumentInverse,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { type ReceiptWrite, recordDocumentEdit } from "./drizzle-document-edits.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";
import { commitRewriteWithinTx, insertJournalRows } from "./drizzle-draft-storage.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import {
  createTurnInverseTreeOperations,
  TreeFault,
} from "./drizzle-turn-inverse-tree-operations.js";
import {
  type PlannedDraft,
  type PlannedInverse,
  planInverseDocument,
} from "./turn-inverse-document-plan.js";

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
  fileAccess: Pick<
    FileAccess,
    "authorizeAt" | "authorize" | "confirmEdit" | "destinationAvailability"
  >;
};

export function createDrizzleTurnInverseService(input: Dependencies) {
  const db = () => currentDrizzleDb(input.db);
  const readDisposition = createDraftDispositionReader(
    createDrizzleDraftDispositionStore(input.db),
  );
  const treeOperations = createTurnInverseTreeOperations(input);
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
      toolCallId: edit.toolCallId,
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
    // History names folders as they were; a hidden one a live folder absorbed since is that one.
    const current = await resolveAbsorbedFolders(input.db, [
      ...new Set(
        rows.flatMap((edit) => (edit.treeChange ? treeChangeFolders(edit.treeChange) : [])),
      ),
    ] as FolderId[]);
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
                toolCallId: edit.toolCallId,
                actor: edit.actor,
                wId: edit.wId,
                kind: edit.kind,
                actionId: edit.actionId,
                consumes: edit.consumes,
                targets: edit.treeChange.targets,
                tree: withCurrentFolders(
                  edit.treeChange,
                  (id) => current.get(id as FolderId) ?? id,
                ),
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
    const facts = await readBranchTreeFacts(db(), named as BranchId[], documentIds);
    return new Map(
      documentIds.map((documentId) => {
        const branches = new Map<BranchId, BranchTreeFacts>();
        for (const branchId of named as BranchId[]) {
          const known = facts.get(branchId)?.get(documentId);
          if (known) branches.set(branchId, known);
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
      const liveAvailability = new Map(
        await Promise.all(
          ids.map(
            async (documentId) =>
              [
                documentId,
                await input.fileAccess.destinationAvailability(
                  { kind: "document", documentId },
                  { kind: "live" },
                ),
              ] as const,
          ),
        ),
      );
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
          const branchIds = [
            ...new Set(
              documentTree.flatMap((row) =>
                row.tree.destination.kind === "draft" ? [row.tree.destination.branchId] : [],
              ),
            ),
          ];
          const activeRows = branchIds.length
            ? await db()
                .select({ id: documentDrafts.id, branchId: documentDrafts.branchId })
                .from(documentDrafts)
                .where(
                  and(
                    eq(documentDrafts.documentId, documentId),
                    eq(documentDrafts.kind, "work_draft"),
                    eq(documentDrafts.status, "active"),
                    inArray(documentDrafts.branchId, branchIds),
                  ),
                )
            : [];
          const occupancy = new Map(activeRows.map((row) => [row.branchId, row.id]));
          const branchOwners = branchIds.length
            ? await db()
                .select({
                  branchId: branches.id,
                  archivedAt: works.archivedAt,
                  deletedAt: works.deletedAt,
                })
                .from(branches)
                .innerJoin(works, eq(works.id, branches.originWorkId))
                .where(inArray(branches.id, branchIds))
            : [];
          const branchAvailability = new Map(
            branchOwners.map((owner) => [
              owner.branchId,
              { frozen: owner.archivedAt !== null || owner.deletedAt !== null },
            ]),
          );
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
            excerptViews: new Map(),
            destinationOf: () => {
              throw new Error("Inverse destinations are resolved after draft capture");
            },
            destinationForBranch: () => {
              throw new Error("Inverse destinations are resolved after draft capture");
            },
          };
          documents.push(document);
          const drafts = new Map<
            string,
            InverseDocument["drafts"] extends ReadonlyMap<string, infer D> ? D : never
          >();
          const queuedDraftIds = [...new Set([...draftIds, ...activeRows.map((row) => row.id)])];
          for (const draftId of queuedDraftIds) {
            const read = await input.drafts.readDraftAt(draftId);
            const documentDraft = read?.documentDraft;
            if (
              !read ||
              documentDraft?.documentId !== documentId ||
              documentDraft.kind !== "work_draft"
            )
              continue;
            const doc = read.checkpoint
              ? materializeDraftRead(read, new Y.Doc({ gc: false }))
              : new Y.Doc({ gc: false });
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
          Object.assign(
            document,
            createInverseDestinationResolver(document, occupancy, branchAvailability, {
              frozen: liveAvailability.get(documentId)?.frozen ?? false,
              removed: removal !== null,
            }),
          );
        }
      } catch (cause) {
        destroyDocuments(documents);
        throw cause;
      }
      return {
        ids,
        draftIds: [...new Set(documents.flatMap((document) => [...document.drafts.keys()]))],
        documents,
        heads,
      };
    });
    // The reader owns its own root snapshot. Do not nest it inside the capture above:
    // a single-connection caller would wait forever for its own read connection.
    try {
      const dispositionDraftIds = new Set<string>();
      for (const document of captured.documents) {
        const destinations = [
          ...document.history.map((part) => document.destinationOf(part.origin)),
          ...document.tree.flatMap((entry) =>
            isTransitionEntry(entry) &&
            entry.tree.op === "create" &&
            entry.tree.destination.kind === "draft"
              ? [document.destinationForBranch(entry.tree.destination.branchId)]
              : [],
          ),
        ];
        for (const destination of destinations) {
          if (destination.kind !== "draft" || destination.state === "gone") continue;
          dispositionDraftIds.add(destination.draftId);
        }
      }
      const views = new Map<string, DraftDispositionView | null>();
      for (const draftId of dispositionDraftIds) views.set(draftId, await readDisposition(draftId));
      const byPart = new Map<string, StoredInversePart["disposition"]>();
      for (const view of views.values())
        for (const part of view?.parts ?? [])
          if (
            part.disposition === "applied" ||
            byPart.get(`${part.editId}:${part.ordinal}`) !== "applied"
          )
            byPart.set(`${part.editId}:${part.ordinal}`, part.disposition);
      for (const document of captured.documents) {
        for (const draftId of dispositionDraftIds) {
          const draft = document.drafts.get(draftId);
          if (!draft) continue;
          const evidence = views.get(draftId);
          if (!evidence || evidence.draft.revision !== draft.documentDraft.revision)
            throw new InverseAttemptMiss();
        }
        document.history = document.history.map((part) => {
          if (part.origin.kind === "live") return { ...part, disposition: "pending" };
          const classified = byPart.get(`${part.editId}:${part.ordinal}`);
          const destination = document.destinationOf(part.origin);
          return {
            ...part,
            disposition:
              classified === "applied"
                ? classified
                : destination.kind === "draft" && destination.state !== "gone"
                  ? "pending"
                  : (classified ?? "discarded"),
          };
        });
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
      const destination = document.destinationOf(part.origin);
      const doc =
        destination.kind === "draft" && destination.state === "gone"
          ? document.live
          : destination.view;
      let excerpt = document.excerptViews.get(doc);
      if (!excerpt) {
        excerpt = new Y.Doc({ gc: false });
        Y.applyUpdate(excerpt, Y.encodeStateAsUpdate(doc));
        document.excerptViews.set(doc, excerpt);
      }
      Y.applyUpdate(excerpt, part.update);
      return {
        before: textInRanges(excerpt, part.effect.deleted),
        after: textInRanges(excerpt, part.effect.inserted),
      };
    },
    async commit({ plans, sequence, kind, userId, query }) {
      const attempt = attemptStorage.getStore();
      if (!attempt) throw new Error("An inverse commits only inside its captured attempt");
      if (!attempt.attempt) throw new ReversalConflictError();
      const scope = attempt.attempt;
      await testHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with provenance on its attempt-local view.
      const planned = new Map(plans.map((plan) => [plan, planInverseDocument(plan, query)]));
      const documents = [...planned.values()];
      // A restore step owns the removed document through tree scope until it recreates live
      // authority. Its later text step and post-commit delivery use that new authority.
      const liveIds = documents
        .filter((entry) => entry.live && entry.living)
        .map((entry) => entry.documentId);
      const handles: string[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      const skips: TurnInverseSkip[] = [];
      const landings: CommittedTreeLanding[] = [];
      const treeRuns = sequence.flatMap(({ plan, step }) =>
        step.kind === "tree" ? [{ document: plan.document, planned: step.planned }] : [],
      );
      const grants = await admitInverse(sequence, query, userId);
      const works = {
        drafts: attempt.draftIds,
        // A drafted tree inverse writes its branch's row: that Work first, as a draft's.
        branches: [
          ...new Set(
            treeRuns.flatMap(({ planned }) =>
              isLiveTransition(planned) ? [] : [planned.destination.branchId],
            ),
          ),
        ],
      };
      const commitScope = <T>(operation: () => Promise<T>) =>
        withLiveDocuments([...new Set(liveIds)].sort(), () => scope.commit(operation));
      const operation = async () => {
        // The live state each plan was computed against is still the head.
        for (const entry of documents) {
          if (!entry.live) continue;
          const [head] = await db()
            .select({ id: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)::bigint` })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.documentId, entry.documentId));
          if (Number(head?.id ?? 0) !== attempt.heads.get(entry.documentId))
            throw new InverseAttemptMiss();
        }
        // The steps in their planned order: text lands in a document a restore before it
        // brought back, and before a delete after it takes the document away.
        for (const { plan, step } of sequence) {
          const entry = planned.get(plan);
          if (!entry) throw new Error("A step's plan is not among the commit's plans");
          const outcome =
            step.kind === "tree"
              ? await commitTreeStep(entry, step, userId, query)
              : await commitTextStep(entry, step, userId, query);
          if (typeof outcome === "string") {
            if (outcome) handles.push(outcome);
          } else if ("kind" in outcome) skips.push(outcome);
          else {
            if (outcome.handle) handles.push(outcome.handle);
            if (outcome.landing) landings.push(outcome.landing);
          }
        }
        for (const entry of documents) await settleDocument(entry, kind, query, deliveries);
      };
      const admitted = await (async () => {
        try {
          if (treeRuns.length)
            return runTreeEditAdmission({
              db: input.db,
              fileAccess: input.fileAccess,
              grants,
              workProjection: input.workProjection,
              works,
              tree: treeScopeRequest(treeRuns, attempt.ids),
              commitScope,
              afterTreeLock: () => confirmTreeCapture(treeRuns),
              operation,
            });
          const commit = () =>
            commitScope(() =>
              input.workProjection.mutate(
                works,
                async () => {
                  for (const id of [...attempt.ids].sort()) await lockDocumentMutation(db(), id);
                  return operation();
                },
                { seam: true },
              ),
            );
          return grants
            ? runWithEditGrants(input.fileAccess, grants, commit)
            : { ok: true as const, value: await commit() };
        } catch (cause) {
          if (cause instanceof TreeScopeChangedError) throw new InverseAttemptMiss();
          throw cause;
        }
      })();
      if (!admitted.ok) throw admitted.refusal;
      attempt.deliveries.push(...deliveries);
      return {
        handles,
        updates: documents.flatMap((entry) => entry.updates.map(({ update }) => update)),
        skips,
        landings,
        reversed: new Map(documents.map((entry) => [entry.documentId, entry.reversed])),
        outcomes: documents.flatMap((entry) => entry.outcomes),
      };
    },
  };

  async function admitInverse(
    sequence: readonly { plan: PreparedDocumentInverse; step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
  ): Promise<FileGrant<"edit">[] | null> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
    // Rollback runs inside the reply's already bound grants. Every interactive inverse supplies
    // its principal explicitly; an absent one here means a composition bug, not live routing.
    if (!principal) return null;
    const requirements = new Map<
      string,
      { documentId: DocumentId; branchId: BranchId | null; restore: boolean }
    >();
    const restoredLive = new Set<DocumentId>();
    for (const { plan, step } of sequence) {
      const documentId = plan.document.documentId;
      if (step.kind === "text") {
        const branchId = step.destination.kind === "draft" ? step.destination.branchId : null;
        const restore = branchId === null && restoredLive.has(documentId);
        requirements.set(`${documentId}:${branchId ?? "live"}:${restore ? "restore" : "content"}`, {
          documentId,
          branchId,
          restore,
        });
        continue;
      }
      const branchId =
        step.planned.destination.kind === "draft" ? step.planned.destination.branchId : null;
      const restore = step.planned.op === "create" || step.planned.op === "restore";
      if (branchId === null && restore) restoredLive.add(documentId);
      requirements.set(`${documentId}:${branchId ?? "live"}:${restore ? "restore" : "tree"}`, {
        documentId,
        branchId,
        restore,
      });
    }
    const admittedRequirements = [...requirements.values()];
    const branchIds = [
      ...new Set(admittedRequirements.flatMap((r) => (r.branchId ? [r.branchId] : []))),
    ];
    const holders = branchIds.length
      ? await db()
          .select({ branchId: branches.id, workId: works.id, handle: works.handle })
          .from(branches)
          .innerJoin(works, eq(works.id, branches.originWorkId))
          .where(inArray(branches.id, branchIds))
      : [];
    const byBranch = new Map(holders.map((holder) => [holder.branchId, holder]));
    const grants: FileGrant<"edit">[] = [];
    for (const requirement of admittedRequirements) {
      const holder = requirement.branchId ? byBranch.get(requirement.branchId) : undefined;
      if (requirement.branchId && !holder) throw new InverseAttemptMiss();
      const grant = await input.fileAccess.authorizeAt(
        principal,
        requirement.restore && !holder
          ? { kind: "restore", documentId: requirement.documentId }
          : holder
            ? { kind: "draft", documentId: requirement.documentId, workId: holder.workId }
            : { kind: "document", documentId: requirement.documentId },
        holder
          ? { kind: "draft", workId: holder.workId, workHandle: holder.handle }
          : { kind: "live" },
        "edit",
      );
      if (isFileAccessDenied(grant)) throw new FileEditRefusedError([grant]);
      grants.push(grant);
    }
    return grants;
  }

  /**
   * The namespaces of every source the tree inverses touch (where the documents are, and the
   * placements they return to), then every document lock of the attempt, then the captured
   * tree states checked again: a document that moved or was removed since is a miss.
   */
  function treeScopeRequest(
    runs: readonly TreeRun[],
    ids: readonly DocumentId[],
  ): TreeScopeRequest {
    const placements = runs.flatMap(({ planned }): TreePlacement[] =>
      isLiveTransition(planned)
        ? [planned.before, planned.after].flatMap((state) => (state.living ? [state.at] : []))
        : [planned.before.moved, planned.after.moved].flatMap((at) => (at ? [at] : [])),
    );
    const drafted = new Map<BranchId, DocumentId[]>();
    for (const { planned, document } of runs)
      if (!isLiveTransition(planned))
        drafted.set(planned.destination.branchId, [
          ...(drafted.get(planned.destination.branchId) ?? []),
          document.documentId,
        ]);
    return {
      documentIds: [...ids],
      placements,
      branches: [...drafted].map(([branchId, documentIds]) => ({ branchId, documentIds })),
    };
  }

  /** Rechecks the attempt's captured tree states after the shared admission locked its scope. */
  async function confirmTreeCapture(runs: readonly TreeRun[]) {
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
   * One tree step, isolated in a savepoint: the live move, restore or delete, or the branch's
   * facts written back, then its row (`recordStep`). A step after one that makes a removal
   * starts from the removal that step made. A destination that can't take it refuses a model
   * inverse whole, and is a reported skip for the card and a rollback, whose other steps still
   * run. Returns the model's handle.
   */
  async function commitTreeStep(
    entry: PlannedInverse,
    step: Extract<InverseStep, { kind: "tree" }>,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<
    | {
        handle: string;
        landing?: CommittedTreeLanding;
      }
    | TurnInverseSkip
  > {
    const { planned } = step;
    const document = entry.plan.document;
    try {
      return await runInDrizzleSavepoint(input.db, async () => {
        const operation = await treeOperations.commit(entry, planned, userId, query);
        const landedAt = await treeOperations.address(entry.documentId, operation.transition);
        const requestedAt = planned.requestedAt;
        const handle = await recordStep(
          entry,
          step,
          {
            transition: operation.transition,
            draftId:
              operation.transition.destination.kind === "draft"
                ? (() => {
                    const destination = document.destinationForBranch(
                      operation.transition.destination.branchId,
                    );
                    return destination.kind === "draft" && destination.state === "active"
                      ? destination.draftId
                      : null;
                  })()
                : null,
            ...(landedAt ? { landedAt } : {}),
          },
          userId,
          query,
        );
        return {
          handle,
          ...(landedAt && requestedAt && landedAt !== requestedAt
            ? {
                landing: {
                  documentId: entry.documentId,
                  handle: planned.entry.wId === null ? "" : editHandle(planned.entry.wId),
                  action:
                    planned.op === "restore" || planned.entry.tree.op === "create"
                      ? ("restored" as const)
                      : ("moved" as const),
                  requestedAt,
                  landedAt,
                },
              }
            : {}),
        };
      });
    } catch (cause) {
      if (!(cause instanceof TreeFault)) throw cause;
      if (query.model)
        throw new TreeInverseRefused(cause.fault, planned, planned.entry.tree.shownAt ?? undefined);
      return {
        kind: "tree",
        documentId: document.documentId,
        uri: document.uri,
        at: planned.entry.tree.shownAt,
        cause: cause.fault,
      };
    }
  }

  /**
   * The one recorder of a committed inverse step, text or tree: who made it (the model's chat
   * and reply with its write ordinal, stamped on the draft journal rows it wrote; the writer;
   * or the system for a rollback), its action and what it consumes, the receipts or tree
   * transition it committed, and its count where it landed. Returns the model's handle.
   */
  async function recordStep(
    entry: PlannedInverse,
    step: InverseStep,
    committed: CommittedStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string> {
    const { documentId } = entry;
    const receipts = "receipts" in committed ? committed.receipts : [];
    const wId = query.model
      ? await input.journal.reserveWriteOrdinal(documentId, query.threadId)
      : undefined;
    if (wId !== undefined)
      for (const receipt of receipts)
        if (receipt.origin.kind === "pending")
          await db()
            .update(draftWriteJournal)
            .set({ wId })
            .where(eq(draftWriteJournal.id, receipt.origin.rowId));
    let treeChange: TreeTransitionChange | undefined;
    if ("transition" in committed) {
      if (step.kind !== "tree") throw new Error("A tree transition records a tree step");
      treeChange = {
        ...committed.transition,
        op: step.planned.op,
        shownAt: entry.plan.document.uri,
        ...(committed.landedAt ? { landedAt: committed.landedAt } : {}),
        seq: await nextEditSeq(db()),
        targets: [{ editId: step.planned.entry.editId, direction: step.planned.direction }],
      };
    }
    await recordDocumentEdit(db(), {
      documentId,
      ...(query.model
        ? {
            actor: "agent" as const,
            threadId: query.threadId,
            turnId: query.turnId,
            responseId: query.responseIdentity?.providerResponseId,
            editScopeId: query.responseIdentity?.editScopeId,
            toolCallId: query.toolCallId,
          }
        : {
            actor: step.actionKind === "rollback" ? ("system" as const) : ("human" as const),
          }),
      wId,
      actorUserId: userId,
      kind: step.actionKind,
      actionId: step.actionId,
      consumes: entry.plan.consumes,
      receipts,
      ...(treeChange ? { treeChange } : {}),
    });
    if ("receipts" in committed) {
      count(entry, committed.branchId, receipts.length);
      entry.outcomes.push({ documentId, branchId: committed.branchId, draftId: committed.draftId });
    } else {
      const branchId = isLiveTransition(committed.transition)
        ? null
        : committed.transition.destination.branchId;
      count(entry, branchId, 1);
      entry.outcomes.push({ documentId, branchId, draftId: committed.draftId });
    }
    return wId === undefined ? "" : editHandle(wId);
  }

  /** Counts what a step committed where it landed. */
  function count(entry: PlannedInverse, branchId: BranchId | null, n: number) {
    entry.reversed.set(branchId, (entry.reversed.get(branchId) ?? 0) + n);
  }

  /**
   * One text step inside the commit scope: its parts written where its plan lands, then its row
   * (`recordStep`).
   * A draft's text is one checkpoint rewrite, written at that draft's first text step. Live text
   * whose document a skipped restore left removed is skipped with the rest of that document's
   * text, which builds on it.
   */
  async function commitTextStep(
    entry: PlannedInverse,
    step: Extract<InverseStep, { kind: "text" }>,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string | TurnInverseSkip> {
    const { plan } = entry;
    const document = plan.document;
    const draft =
      step.destination.kind === "draft" ? entry.drafts.get(step.destination) : undefined;
    const parts = entry.edits.get(step.edit);
    if (!parts) throw new Error("A text step was not planned with its document");
    if (!draft && (entry.stopped || !entry.living)) {
      entry.stopped = true;
      return {
        kind: "text",
        documentId: document.documentId,
        uri: document.uri,
        before: "",
        after: "",
        cause: "not_restored",
      };
    }
    if (draft && !draft.origins.size) await rewriteDraft(entry, draft, userId, query);
    const origins: EditOrigin[] = draft ? (draft.origins.get(step.edit) ?? []) : [];
    if (!draft)
      for (const part of parts)
        origins.push({
          kind: "live",
          seq: await input.journal.append(document.documentId, part.update, {
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
          }),
        });
    const receipts = parts.map((part, ordinal) => {
      const origin = origins[ordinal];
      if (!origin) throw new Error("Inverse part has no journal origin");
      return { ...part, origin };
    });
    entry.committed.push(step.edit);
    const landedDraftId = draft?.draftId ?? null;
    entry.updates.push(...parts.map((part) => ({ draftId: landedDraftId, update: part.update })));
    return recordStep(
      entry,
      step,
      { draftId: landedDraftId, branchId: draft?.branchId ?? null, receipts },
      userId,
      query,
    );
  }

  /**
   * Shape (a): the captured draft plus its text steps' parts, written whole as the checkpoint
   * at the revision it was captured at; the journal rows are inserted under the row lock, inside
   * the checkpoint they belong to.
   */
  async function rewriteDraft(
    entry: PlannedInverse,
    draft: PlannedDraft,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ) {
    const edits = draft.edits.flatMap((edit) =>
      (entry.edits.get(edit) ?? []).map((part) => ({ edit, part })),
    );
    const rewritten = await commitRewriteWithinTx(db(), {
      draftId: draft.draftId as string,
      policy: { kind: "exact", revision: draft.revision },
      work: "active",
      doc: draft.view,
      withinLock: async () => {
        const rowIds = await insertJournalRows(
          db(),
          edits.map(({ part }) => ({
            draftId: draft.draftId as string,
            updateData: part.update,
            source: entry.source,
            threadId: query.model ? query.threadId : null,
            turnId: query.model ? query.turnId : null,
            actorUserId: userId ?? null,
            updateMeta: {
              ...(query.model && query.responseIdentity
                ? {
                    authoringResponseId: query.responseIdentity.providerResponseId,
                    editScopeId: query.responseIdentity.editScopeId,
                  }
                : {}),
              restorationAliases: part.aliases.map((alias) => ({
                source: { ...alias.source, length: alias.len },
                target: { ...alias.target, length: alias.len },
              })),
            },
          })),
        );
        for (const [position, { edit }] of edits.entries()) {
          const rowId = rowIds[position];
          if (rowId === undefined) throw new Error("Inverse journal was not inserted");
          const origins = draft.origins.get(edit) ?? [];
          origins.push({ kind: "pending", draftId: draft.draftId as string, rowId });
          draft.origins.set(edit, origins);
        }
      },
    });
    if (rewritten.status !== "committed") throw new InverseAttemptMiss();
  }

  /** After every step: a rollback's remaining pending rows, and the document's delivery. */
  async function settleDocument(
    entry: PlannedInverse,
    kind: "undo" | "redo" | "revert" | "rollback",
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<void> {
    const { plan } = entry;
    const document = plan.document;
    if (kind === "rollback") {
      const accepted = new Set(
        entry.committed.flatMap((edit) =>
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
    const landed = new Set(entry.updates.map(({ draftId }) => draftId));
    if (!landed.size) return;
    deliveries.push(async () => {
      for (const draftId of landed) {
        if (draftId) {
          input.onDraftCommitted(draftId);
          await input.draftCoordinator.deliverCommitted(draftId);
        } else {
          await input.coordinator.deliver(document.documentId);
          await input.refreshDocument(document.documentId);
          await input.flushLivePull(document.documentId);
        }
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
    });
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

/** A tree step's document and transition, for the locks the commit takes. */
type TreeRun = { document: InverseDocument; planned: PlannedTreeInverse };

/** A commit attempt of an inverse: four, then one classification pass (section 2.4, F5). */
const INVERSE_ATTEMPTS = 4;

type InverseCapture = {
  ids: DocumentId[];
  draftIds: string[];
  documents: InverseDocument[];
  /** Each document's live head (`max(document_yjs_updates.id)`) at the capture. */
  heads: Map<DocumentId, number>;
};

/** What a step's payload committed, for `recordStep`: its text receipts, or its tree transition. */
type CommittedStep =
  | { draftId: string | null; branchId: BranchId | null; receipts: ReceiptWrite["receipts"] }
  | {
      transition: TreeTransition;
      draftId: string | null;
      landedAt?: string;
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
    for (const excerpt of document.excerptViews.values()) excerpt.destroy();
    document.live.destroy();
    for (const draft of document.drafts.values()) draft.doc.destroy();
  }
}
