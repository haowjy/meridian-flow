/**
 * Durable multi-document inverse admission: a lock-free capture, a plan on attempt-local
 * documents, one commit scope that takes the capture again under its locks and writes only if
 * it matches; delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { editHandle, type UpdateJournal } from "@meridian/agent-edit/integration";
import { textInRanges } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId, DocumentId, DraftOwner, UserId } from "@meridian/contracts";
import type { TurnInverseSkip } from "@meridian/contracts/protocol";
import {
  branches,
  type Database,
  documentDrafts,
  documentEditParts,
  documentEdits,
  draftWriteJournal,
  type EditOrigin,
} from "@meridian/database";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { branchOwnerSql } from "../../../shared/draft-owner.js";
import {
  currentDrizzleDb,
  deferUntilDrizzleCommit,
  runInDrizzleSavepoint,
} from "../../../shared/drizzle-transaction.js";
import { testHook } from "../../../shared/test-hooks.js";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import {
  type FileAccess,
  FileEditRefusedError,
  type FileGrant,
  isFileAccessDenied,
  runEditAdmission,
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
  /** A revert changes pending membership, so it reconciles the Works' counts through it. */
  workProjection: Pick<WorkProjectionMutation, "mutate">;
  /** A removed document's text is not reversed; its record words the refusal. */
  removals: DocumentRemovals;
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
      toolCallId: edit.toolCallId,
      consumes: edit.consumes,
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
   * Every affected document as the plan will see it: live, each draft at its revision without
   * merging live identity, the history, and each draft's Work lifecycle from its row. Taken
   * with no lock, so its reads need not agree; `facts` records what each returned, and the
   * commit takes the capture again under its locks and plans nothing unless the two match.
   */
  async function capture(query: TurnInverseQuery): Promise<InverseCapture> {
    const facts: unknown[] = [];
    const captured = await (async () => {
      const ids = await selectedDocuments(query);
      const rows = await history(ids);
      const draftIds = inverseDraftIds(query, rows);
      const parts: StoredInversePart[] = rows.map((part) => ({
        ...part,
        disposition: "pending",
      }));
      const documents: InverseDocument[] = [];
      const removals = await input.removals.lookup(ids);
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
          // outlived it plan their inverse over the retained live history.
          const released = removal?.reason === "discarded";
          const { doc: live, room: liveRoomName } = released
            ? { doc: new Y.Doc({ gc: false }), room: null }
            : await materialize(documentId);
          await testHook("inverse.afterCaptureRead");
          facts.push({
            documentId,
            removal,
            live: Y.encodeSnapshotV2(Y.snapshot(live)),
            liveRoom: liveRoomName,
            liveFrozen: liveAvailability.get(documentId)?.frozen ?? false,
          });
          const document: InverseDocument = {
            documentId,
            // A deleted document has no address: the model's path, or where it last stood.
            uri: (await input.resolveDocumentUri(documentId)) ?? query.path ?? documentId,
            live,
            liveRoom: removal ? null : liveRoomName,
            removal,
            history: parts.filter((part) => part.documentId === documentId),
            drafts: new Map(),
            excerptViews: new Map(),
            destinationOf: () => {
              throw new Error("Inverse destinations are resolved after draft capture");
            },
          };
          documents.push(document);
          const drafts = new Map<
            string,
            InverseDocument["drafts"] extends ReadonlyMap<string, infer D> ? D : never
          >();
          for (const draftId of draftIds) {
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
            const [name] = await db()
              .select({ handle: branchOwnerSql(branches).handle })
              .from(branches)
              .where(eq(branches.id, documentDraft.branchId));
            facts.push({
              draftId,
              revision: documentDraft.revision,
              lifecycle: documentDraft.lifecycle,
              name: name?.handle,
            });
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
            createInverseDestinationResolver(document, {
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
        fingerprint: "",
      };
    })();
    try {
      // A closed draft keeps its bytes and its Apply record: what was applied before the
      // close is read from it, so a discarded branch does not make applied parts "discarded".
      const dispositionDraftIds = new Set<string>();
      for (const document of captured.documents) {
        for (const part of document.history)
          if (part.origin.kind === "pending" && document.drafts.has(part.origin.draftId))
            dispositionDraftIds.add(part.origin.draftId);
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
          // An open draft's unapplied part stays pending: "not pending any more" also means the
          // writer retyped it, which the receipt must call edited, not discarded.
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
        facts.push({
          documentId: document.documentId,
          uri: document.uri,
          history: document.history.map((part) => [part.id, part.disposition]),
        });
      }
      captured.fingerprint = fingerprintOf(facts);
      return captured;
    } catch (cause) {
      destroyDocuments(captured.documents);
      throw cause;
    }
  }

  /**
   * The capture taken again under the commit's locks (Works, then the document keys, then the
   * drafts' rows here): a write that landed since any of the first capture's reads, or between
   * two of them, changes what it returns, and the attempt misses.
   */
  async function confirmCapture(query: TurnInverseQuery, attempt: InverseCapture): Promise<void> {
    if (attempt.draftIds.length)
      await db()
        .select({ id: documentDrafts.id })
        .from(documentDrafts)
        .where(inArray(documentDrafts.id, [...attempt.draftIds].sort()))
        .orderBy(documentDrafts.id)
        .for("update");
    const now = await capture(query);
    destroyDocuments(now.documents);
    if (now.fingerprint !== attempt.fingerprint) throw new InverseAttemptMiss();
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
    async readHistory(documentId) {
      return (await history([documentId])).map((part) => ({ ...part, disposition: "pending" }));
    },
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
      const handles: string[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      const skips: TurnInverseSkip[] = [];
      const grants = await admitInverse(sequence, query, userId);
      const works = { drafts: attempt.draftIds, branches: [] };
      const operation = async () => {
        // What each plan was computed against is still what the documents hold.
        await confirmCapture(query, attempt);
        for (const { plan, step } of sequence) {
          const entry = planned.get(plan);
          if (!entry) throw new Error("A step's plan is not among the commit's plans");
          const outcome = await commitTextStep(entry, step, userId, query);
          if (typeof outcome === "string") {
            if (outcome) handles.push(outcome);
          } else skips.push(outcome);
        }
        for (const entry of documents) await settleDocument(entry, kind, query, deliveries);
      };
      const admitted = await runEditAdmission({
        fileAccess: input.fileAccess,
        grants,
        workProjection: input.workProjection,
        works,
        commitScope: (operation) => scope.commit(operation),
        acquireMutationScope: async () => {
          for (const id of [...attempt.ids].sort()) await lockDocumentMutation(db(), id);
        },
        operation,
      });
      if (!admitted.ok) throw admitted.refusal;
      attempt.deliveries.push(...deliveries);
      return {
        handles,
        updates: documents.flatMap((entry) => entry.updates.map(({ update }) => update)),
        skips,
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
    // Every inverse supplies its principal explicitly; an absent one here means a composition
    // bug, not live routing.
    if (!principal) return null;
    const requirements = new Map<string, { documentId: DocumentId; branchId: BranchId | null }>();
    for (const { plan, step } of sequence) {
      const documentId = plan.document.documentId;
      const branchId = step.destination.kind === "draft" ? step.destination.branchId : null;
      requirements.set(`${documentId}:${branchId ?? "live"}`, { documentId, branchId });
    }
    const admittedRequirements = [...requirements.values()];
    const branchIds = [
      ...new Set(admittedRequirements.flatMap((r) => (r.branchId ? [r.branchId] : []))),
    ];
    const owner = branchOwnerSql(branches);
    const holders = branchIds.length
      ? await db()
          .select({
            branchId: branches.id,
            projectId: branches.projectId,
            workId: owner.workId,
            rootThreadId: owner.rootThreadId,
            handle: owner.handle,
          })
          .from(branches)
          .where(inArray(branches.id, branchIds))
      : [];
    const byBranch = new Map(holders.map((holder) => [holder.branchId, holder]));
    const grants: FileGrant<"edit">[] = [];
    for (const requirement of admittedRequirements) {
      const found = requirement.branchId ? byBranch.get(requirement.branchId) : undefined;
      const holder = found && holderOwner(found);
      if (requirement.branchId && !holder) throw new InverseAttemptMiss();
      const grant = await input.fileAccess.authorizeAt(
        principal,
        holder
          ? { kind: "draft", documentId: requirement.documentId, owner: holder.owner }
          : { kind: "document", documentId: requirement.documentId },
        holder
          ? { kind: "draft", owner: holder.owner, ownerHandle: holder.handle }
          : { kind: "live" },
        "edit",
      );
      if (isFileAccessDenied(grant)) throw new FileEditRefusedError([grant]);
      grants.push(grant);
    }
    return grants;
  }

  /**
   * The one recorder of a committed inverse step: who made it (the model's chat and reply with
   * its write ordinal, stamped on the draft journal rows it wrote; or the writer), its action
   * and what it consumes, the receipts it committed, and its count
   * where it landed. Returns the model's handle.
   */
  async function recordStep(
    entry: PlannedInverse,
    step: InverseStep,
    committed: CommittedStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string> {
    const { documentId } = entry;
    const { receipts } = committed;
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
        : {
            actor: "human" as const,
          }),
      wId,
      actorUserId: userId,
      kind: step.actionKind,
      actionId: step.actionId,
      consumes: entry.plan.consumes,
      receipts,
    });
    count(entry, committed.branchId, receipts.length);
    entry.outcomes.push({ documentId, branchId: committed.branchId, draftId: committed.draftId });
    return wId === undefined ? "" : editHandle(wId);
  }

  /** Counts what a step committed where it landed. */
  function count(entry: PlannedInverse, branchId: BranchId | null, n: number) {
    entry.reversed.set(branchId, (entry.reversed.get(branchId) ?? 0) + n);
  }

  /**
   * One step inside the commit scope: its parts written where its plan lands, then its row
   * (`recordStep`). A draft's text is one checkpoint rewrite, written at that draft's first step.
   */
  async function commitTextStep(
    entry: PlannedInverse,
    step: InverseStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string> {
    const { plan } = entry;
    const document = plan.document;
    const draft =
      step.destination.kind === "draft" ? entry.drafts.get(step.destination) : undefined;
    const parts = entry.edits.get(step.edit);
    if (!parts) throw new Error("A text step was not planned with its document");
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
                  authoringResponseId: query.responseIdentity.modelResponseId,
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
                    authoringResponseId: query.responseIdentity.modelResponseId,
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

  /** After every step: the document's delivery. */
  async function settleDocument(
    entry: PlannedInverse,
    kind: "undo" | "redo" | "revert",
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<void> {
    const { plan } = entry;
    const document = plan.document;
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
      if (kind !== "revert" && !query.model && query.turnId)
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

  return createTurnInverseService(store);
}

/** A commit attempt of an inverse: four, then one classification pass (section 2.4, F5). */
const INVERSE_ATTEMPTS = 4;

type InverseCapture = {
  ids: DocumentId[];
  draftIds: string[];
  documents: InverseDocument[];
  /** What every read of the capture returned, hashed: `confirmCapture` compares it. */
  fingerprint: string;
};

/** A stable hash of the capture's reads: maps as entries, bytes and bigints as text. */
function fingerprintOf(facts: unknown[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(facts, (_key, value) =>
        value instanceof Map
          ? [...value]
          : value instanceof Uint8Array
            ? Buffer.from(value).toString("base64")
            : typeof value === "bigint"
              ? value.toString()
              : value,
      ),
    )
    .digest("hex");
}

/** What a step committed, for `recordStep`. */
type CommittedStep = {
  draftId: string | null;
  branchId: BranchId | null;
  receipts: ReceiptWrite["receipts"];
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

/** The owner a branch's columns name; a branch with none (a purged Work's) holds nothing. */
function holderOwner(row: {
  projectId: string;
  workId: string | null;
  rootThreadId: string | null;
  handle: string | null;
}): { owner: DraftOwner; handle: string | null } | null {
  if (row.workId) return { owner: { kind: "work", workId: row.workId }, handle: row.handle };
  if (row.rootThreadId)
    return {
      owner: { kind: "lineage", projectId: row.projectId, rootThreadId: row.rootThreadId },
      handle: row.handle,
    };
  return null;
}
