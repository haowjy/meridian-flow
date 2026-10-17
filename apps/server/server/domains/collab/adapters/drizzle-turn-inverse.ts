/**
 * Durable multi-document inverse admission: a lock-free capture, a plan on attempt-local
 * documents, one commit scope that validates the capture; publishes only after it commits.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ComputedInverseEdit,
  DocumentCoordinator,
  UpdateJournal,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates, textInRanges } from "@meridian/agent-edit/yjs-mutation";
import type { DocumentId, UserId } from "@meridian/contracts";
import {
  branchWriteJournal,
  type Database,
  documentEditParts,
  documentEdits,
  documentYjsUpdates,
  type EditOrigin,
  works,
} from "@meridian/database";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
  runInRootDrizzleReadSnapshot,
} from "../../../shared/drizzle-transaction.js";
import { confirmScopedEdits } from "../../../shared/edit-confirmation.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import { type Attempt, runBoundedAttempts } from "../domain/branch-attempts.js";
import type { BranchCoordinator } from "../domain/branch-coordinator.js";
import { type BranchStore, materializeBranchRead } from "../domain/branch-store.js";
import { collabHook } from "../domain/collab-test-hooks.js";
import { documentEffectsEqual } from "../domain/document-content.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import { ReversalConflictError } from "../domain/reversal-conflict.js";
import {
  createTurnInverseService,
  type InverseDocument,
  type PreparedDocumentInverse,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { bumpBranchRevisions, commitRewriteWithinTx } from "./drizzle-branch-storage.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";

type Dependencies = {
  db: Database;
  journal: UpdateJournal;
  branches: BranchStore;
  coordinator: DocumentCoordinator;
  branchCoordinator: Pick<BranchCoordinator, "broadcastUpdate">;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  flushLivePull(documentId: DocumentId): Promise<void>;
  notices: import("../domain/reversal-notices.js").TurnInverseNoticePort;
  /** Revert, rollback and mark-blocking change pending membership, so they publish through it. */
  workProjection: Pick<WorkProjectionMutation, "mutatePending">;
};
export function createDrizzleTurnInverseService(input: Dependencies) {
  const db = () => currentDrizzleDb(input.db);
  async function selectedDocuments(query: TurnInverseQuery): Promise<DocumentId[]> {
    if (query.model) return [...new Set(query.documentIds ?? [])].sort();
    return [
      ...new Set((await readTurnEditTargets(db(), query)).map((target) => target.documentId)),
    ].sort();
  }
  async function history(documentIds: DocumentId[]): Promise<StoredInversePart[]> {
    if (!documentIds.length) return [];
    const rows = await db()
      .select({ part: documentEditParts, edit: documentEdits })
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
  async function materialize(documentId: DocumentId): Promise<Y.Doc> {
    const snapshot = await input.journal.read(documentId);
    const doc = new Y.Doc({ gc: false });
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    return doc;
  }
  /** The branches an inverse of `query` may read or write: its own and every pending hold. */
  function inverseBranchIds(query: TurnInverseQuery, parts: StoredInversePart[]): string[] {
    return [
      ...new Set([
        ...(query.branchId ? [query.branchId] : []),
        ...parts
          .filter(
            (part) =>
              (part.threadId === query.threadId &&
                (query.model || !query.turnId || part.turnId === query.turnId) &&
                (query.model ||
                  !query.responseIdentity ||
                  part.editScopeId === query.responseIdentity.editScopeId)) ||
              (part.kind !== "write" && part.placement.kind === "pending"),
          )
          .flatMap((part) =>
            [part.origin, part.placement].flatMap((placement) =>
              placement.kind === "pending" ? [placement.branchId] : [],
            ),
          ),
      ]),
    ].sort();
  }

  /**
   * One read-only snapshot of every affected document: live at its head, each draft at its
   * revision merged with that live state (the planning document main builds), the history,
   * and each draft's Work lifecycle from its row. No lock of any kind.
   */
  async function capture(query: TurnInverseQuery): Promise<InverseCapture> {
    return runInRootDrizzleReadSnapshot(input.db, async () => {
      const ids = await selectedDocuments(query);
      const parts = await history(ids);
      const branchIds = inverseBranchIds(query, parts);
      const documents: InverseDocument[] = [];
      const heads = new Map<DocumentId, number>();
      try {
        for (const documentId of ids) {
          const live = await materialize(documentId);
          const [head] = await db()
            .select({ id: sql<number>`coalesce(max(${documentYjsUpdates.id}), 0)::bigint` })
            .from(documentYjsUpdates)
            .where(eq(documentYjsUpdates.documentId, documentId));
          heads.set(documentId, Number(head?.id ?? 0));
          const document: InverseDocument = {
            documentId,
            uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
            live,
            history: parts.filter((part) => part.documentId === documentId),
            drafts: new Map(),
          };
          documents.push(document);
          const drafts = new Map<
            string,
            InverseDocument["drafts"] extends ReadonlyMap<string, infer D> ? D : never
          >();
          for (const branchId of branchIds) {
            const read = await input.branches.readBranchAt(branchId);
            const branch = read?.branch;
            if (!read || branch?.documentId !== documentId || branch.status !== "active") continue;
            const doc = materializeBranchRead(read, new Y.Doc({ gc: false }));
            // A draft action always includes the captured live cut.
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
            const [name] = branch.workId
              ? await db()
                  .select({ slug: works.slug })
                  .from(works)
                  .where(eq(works.id, branch.workId))
              : [];
            drafts.set(branchId, {
              branch,
              doc,
              name: name?.slug ? `@${name.slug}` : "@/",
              frozen: branch.lifecycle !== "active",
            });
          }
          document.drafts = drafts;
        }
      } catch (cause) {
        destroyDocuments(documents);
        throw cause;
      }
      return { ids, branchIds, documents, heads };
    });
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
    const publications: (() => Promise<void>)[] = [];
    // Publication reads the documents through their coordinators and may pull: only once the
    // attempt completed, and outside every mutex it held.
    attempt?.own({
      async transfer() {
        const publish = async () => {
          for (const publication of publications) await publication();
        };
        if (!deferUntilDrizzleCommit(publish)) await publish();
      },
      dispose() {},
    });
    // No lease: a rewrite that lands between this capture and the commit moves a captured
    // revision or live head, which the commit scope finds and turns into a whole-attempt miss.
    const captured = await capture(query);
    try {
      return await attemptStorage.run({ ...captured, attempt, publications }, () =>
        run(captured.documents),
      );
    } finally {
      destroyDocuments(captured.documents);
    }
  }

  const store: TurnInverseStore = {
    withCapturedDocuments: attempts,
    async markBlocking(branchIds) {
      if (!branchIds.length) return;
      // Its own short write after the capture: Work rows, then the held rows, then the bump.
      await runInDrizzleSavepoint(input.db, () =>
        input.workProjection.mutatePending({ branches: branchIds }, () =>
          bumpBranchRevisions(db(), branchIds, { blocking: true }),
        ),
      );
    },
    describePart(document, part) {
      const doc =
        part.origin.kind === "pending"
          ? (document.drafts.get(part.origin.branchId)?.doc ?? document.live)
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
      await collabHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with their provenance on its attempt-local view,
      // and a draft destination's effect against the captured live state.
      const planned = plans.map((plan) => planDocument(plan, query));
      const liveIds = planned.filter((entry) => !entry.draft).map((entry) => entry.documentId);
      const handles: string[] = [];
      const publications: (() => Promise<void>)[] = [];
      await withLiveDocuments([...new Set(liveIds)].sort(), () =>
        scope.commit(() =>
          // The whole captured write set enters the Work boundary before any other lock
          // (decision D17): Works, then the inverse and document locks, then the rows.
          input.workProjection.mutatePending({ branches: attempt.branchIds }, async () => {
            for (const id of attempt.ids)
              await db().execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`document-inverse:${id}`},0::bigint))`,
              );
            if (query.model) await confirmScopedEdits();
            for (const key of [...attempt.ids, ...attempt.branchIds].sort())
              await lockDocumentMutation(db(), key);
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
            for (const entry of planned)
              handles.push(...(await commitDocument(entry, kind, userId, query, publications)));
          }),
        ),
      );
      attempt.publications.push(...publications);
      return handles;
    },
  };

  /** Each part of a plan applied to its view with its restoration provenance; no I/O. */
  function planDocument(plan: PreparedDocumentInverse, query: TurnInverseQuery): PlannedInverse {
    const document = plan.document;
    const draftEntry = plan.branchId ? document.drafts.get(plan.branchId) : undefined;
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
      draft:
        draftEntry && updates.length
          ? {
              branchId: draftEntry.branch.branchId,
              revision: draftEntry.branch.revision,
              generation: draftEntry.branch.generation,
              view,
              effect: {
                hasEffect: !documentEffectsEqual(document.live, view),
                liveCut: Y.encodeStateAsUpdate(document.live),
              },
            }
          : draftEntry
            ? {
                branchId: draftEntry.branch.branchId,
                revision: draftEntry.branch.revision,
                generation: draftEntry.branch.generation,
                view,
              }
            : undefined,
      source: query.model ? "agent" : "writer",
    };
  }

  /** One planned document inside the commit scope: its rows, receipts, statuses, publication. */
  async function commitDocument(
    entry: PlannedInverse,
    kind: "undo" | "redo" | "revert" | "rollback",
    userId: UserId | undefined,
    query: TurnInverseQuery,
    publications: (() => Promise<void>)[],
  ): Promise<string[]> {
    const { plan, draft } = entry;
    const document = plan.document;
    const handles: string[] = [];
    const origins: EditOrigin[][] = entry.edits.map(() => []);
    if (draft && entry.updates.length) {
      // Shape (a): the captured branch ⊕ live ⊕ the inverse parts, written whole as the
      // checkpoint at the revision it was captured at; the rows are inserted under the row
      // lock, inside the checkpoint they belong to.
      const rewritten = await commitRewriteWithinTx(db(), {
        branchId: draft.branchId,
        policy: { kind: "exact", revision: draft.revision },
        fence: { kind: "none" },
        work: "active",
        doc: draft.view,
        ...(draft.effect ? { effect: draft.effect } : {}),
        withinLock: async () => {
          for (const [index, { parts }] of entry.edits.entries())
            for (const part of parts) {
              const [row] = await db()
                .insert(branchWriteJournal)
                .values({
                  branchId: draft.branchId,
                  generation: draft.generation,
                  updateData: Buffer.from(part.update),
                  source: entry.source,
                  threadId: query.model ? query.threadId : null,
                  turnId: query.model ? query.turnId : null,
                  actorUserId: userId ?? null,
                  draftBaseUpdateSeq: sql`coalesce((select max(id) from document_yjs_updates where document_id = ${document.documentId}),0)`,
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
                })
                .returning({ id: branchWriteJournal.id });
              if (!row) throw new Error("Inverse journal was not inserted");
              origins[index].push({
                kind: "pending",
                branchId: draft.branchId,
                generation: draft.generation,
                rowId: row.id,
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
        handles.push(`w${wId}`);
        for (const receipt of receipts)
          if (receipt.origin.kind === "pending")
            await db()
              .update(branchWriteJournal)
              .set({ wId })
              .where(eq(branchWriteJournal.id, receipt.origin.rowId));
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
          part.placement.kind === "pending" &&
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
        part.placement.kind === "pending" ? [part.placement.rowId] : [],
      );
      if (rowIds.length) {
        const flipping = await db()
          .select({ branchId: branchWriteJournal.branchId })
          .from(branchWriteJournal)
          .where(
            and(inArray(branchWriteJournal.id, rowIds), eq(branchWriteJournal.status, "active")),
          );
        await bumpBranchRevisions(
          db(),
          flipping.map((row) => row.branchId),
        );
        await db()
          .update(branchWriteJournal)
          .set({ status: "rollback_pending" })
          .where(
            and(inArray(branchWriteJournal.id, rowIds), eq(branchWriteJournal.status, "active")),
          );
      }
    }
    if (!entry.updates.length) return handles;
    const publish = async () => {
      if (draft)
        input.branchCoordinator.broadcastUpdate({
          branchId: draft.branchId,
          update: Y.mergeUpdates(entry.updates),
        });
      else {
        await input.coordinator.recover(document.documentId);
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
    publications.push(publish);
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

/** A commit attempt of an inverse: four, then one classification pass (section 2.4, F5). */
const INVERSE_ATTEMPTS = 4;

type InverseCapture = {
  ids: DocumentId[];
  branchIds: string[];
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
    branchId: string;
    revision: number;
    generation: number;
    view: Y.Doc;
    effect?: { hasEffect: boolean; liveCut: Uint8Array };
  };
  source: "agent" | "writer";
};

/** The attempt a store call runs in: its capture, and whether it may still commit. */
const attemptStorage = new AsyncLocalStorage<
  InverseCapture & { attempt: Attempt | null; publications: (() => Promise<void>)[] }
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
