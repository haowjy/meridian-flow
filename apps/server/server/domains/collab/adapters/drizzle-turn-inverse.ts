/**
 * Durable multi-document inverse admission: a lock-free capture, a plan on attempt-local
 * documents, one commit scope that takes the capture again under its locks and writes only if
 * it matches; delivers only after it commits.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { ChangeRead } from "@meridian/agent-edit/content-merge";
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { editHandle, type UpdateJournal } from "@meridian/agent-edit/integration";
import {
  captureMutationUpdates,
  type ItemRanges,
  textInRanges,
} from "@meridian/agent-edit/yjs-mutation";
import type { BranchId, CommandId, DocumentId, DraftOwner, UserId } from "@meridian/contracts";
import type { ApplyClickResult } from "@meridian/contracts/branches";
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
import {
  applyCommandEffects,
  applyCommandTrees,
  commands as commandRows,
} from "@meridian/database/schema";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  branchOwnerSql,
  closedOwnerOf,
  mergeOwnerLocks,
  type OwnerLocks,
} from "../../../shared/draft-owner.js";
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
import { type Attempt, runBoundedAttempts } from "../domain/draft-attempts.js";
import {
  draftSchema,
  isPending,
  readDraftChanges,
  takeOutStanding,
} from "../domain/draft-changes.js";
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
import { createDrizzleTreeHistory } from "./drizzle-tree-history.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";
import { createTurnTreeInverse, NO_TREE_STEPS } from "./drizzle-turn-tree-inverse.js";
import { type PlannedInverse, planInverseDocument } from "./turn-inverse-document-plan.js";

type Dependencies = {
  db: Database;
  journal: UpdateJournal;
  drafts: DraftStore;
  coordinator: LiveDocumentCoordinator;
  draftCoordinator: Pick<DraftCoordinator, "deliverCommitted" | "loadBase" | "prepareAppend">;
  onDraftCommitted(draftId: string): void;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  /** Where a document in Trash last stood, which names it while a Redo brings it back. */
  resolveLastDocumentUri(documentId: string, branchId?: BranchId): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  flushLivePull(documentId: DocumentId): Promise<void>;
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
  const readDisposition = createDraftDispositionReader(
    createDrizzleDraftDispositionStore(input.db),
  );
  /**
   * An Undo that deletes a created document leaves its text with the document.
   */
  async function createdDocumentsOf(query: TurnInverseQuery) {
    return new Set((await treePlanOf(query)).createdDocuments);
  }
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
          delta: documentEditParts.delta,
          origin: documentEditParts.origin,
          purgedDisposition: documentEditParts.purgedDisposition,
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
    /** A part whose draft the Trash purge deleted: what it recorded became of the part. */
    const purged = new Map<number, "applied" | "discarded">();
    const captured = await (async () => {
      const createdDocuments = await createdDocumentsOf(query);
      const ids = await selectedDocuments(query);
      const rows = await history(ids);
      for (const row of rows) if (row.purgedDisposition) purged.set(row.id, row.purgedDisposition);
      const parts: StoredInversePart[] = rows.map((part) => ({
        ...part,
        disposition: "pending",
      }));
      const partsByDocument = new Map<string, StoredInversePart[]>();
      for (const part of parts) {
        const list = partsByDocument.get(part.documentId);
        if (list) list.push(part);
        else partsByDocument.set(part.documentId, [part]);
      }
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
          // A delete keeps the document's bytes, and its drafts that outlived it plan their
          // inverse over the retained live history.
          const { doc: live, room: liveRoomName } = await materialize(documentId);
          await testHook("inverse.afterCaptureRead");
          facts.push({
            documentId,
            removal,
            live: Y.encodeSnapshotV2(Y.snapshot(live)),
            liveRoom: liveRoomName,
            liveClosed: liveAvailability.get(documentId)?.closed ?? null,
            createdInTurn: createdDocuments.has(documentId),
          });
          const document: InverseDocument = {
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
          for (const draftId of inverseDraftIds(query, document.history)) {
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
              closed: closedOwnerOf(documentDraft.lifecycle),
            });
          }
          document.drafts = drafts;
          Object.assign(
            document,
            createInverseDestinationResolver(document, {
              closed: liveAvailability.get(documentId)?.closed ?? null,
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
      const appliedByPart = new Map<string, string>();
      for (const view of views.values())
        for (const part of view?.parts ?? [])
          if (part.appliedBy) appliedByPart.set(`${part.editId}:${part.ordinal}`, part.appliedBy);
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
        // What each change of a drafted AI edit is in its open draft: read from the edit's delta
        // against the draft's text, never from item ids.
        const changesOf = new Map<number, readonly ChangeRead[]>();
        for (const [draftId, draft] of document.drafts) {
          if (draft.documentDraft.status !== "active") continue;
          const drafted = document.history.filter(
            (part) => part.origin.kind === "pending" && part.origin.draftId === draftId,
          );
          if (!drafted.length) continue;
          for (const [id, read] of readDraftChanges(draft.doc, drafted).parts)
            changesOf.set(id, read.changes);
        }
        document.history = document.history.map((part) => {
          if (part.origin.kind === "live") return { ...part, disposition: "pending" };
          const classified = byPart.get(`${part.editId}:${part.ordinal}`);
          const appliedBy =
            classified === "applied"
              ? appliedByPart.get(`${part.editId}:${part.ordinal}`)
              : undefined;
          const destination = document.destinationOf(part.origin);
          const changes = changesOf.get(part.id);
          return {
            ...part,
            ...(appliedBy ? { appliedBy } : {}),
            ...(changes ? { changes, waiting: changes.some(isPending) } : { waiting: false }),
            disposition:
              classified === "applied"
                ? classified
                : destination.kind === "draft" && destination.state !== "gone"
                  ? "pending"
                  : (classified ?? purged.get(part.id) ?? "discarded"),
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

  /**
   * An owner that closed after this attempt's capture: the next capture sees it closed and
   * plans its targets as `returned` skips. Any other refusal is the policy's and stands.
   */
  function refusalOrMiss(refusal: FileEditRefusedError): Error {
    return refusal.refused.every(
      (denial) => denial.reason === "work_archived" || denial.reason === "chat_frozen",
    )
      ? new InverseAttemptMiss()
      : refusal;
  }

  const store: TurnInverseStore = {
    withCapturedDocuments: attempts,
    async ownersOf(query, userId) {
      let captured: InverseCapture;
      try {
        captured = await capture(query);
      } catch (cause) {
        if (cause instanceof InverseAttemptMiss) throw new TreeOwnersMoved();
        throw cause;
      }
      const { ids, draftIds } = captured;
      destroyDocuments(captured.documents);
      const tree = await treePlanOf(query);
      let owners = mergeOwnerLocks(
        await input.workProjection.ownersOf({ drafts: draftIds, branches: tree.branches }),
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
    async applyCommands(commandIds) {
      const found = new Map<
        string,
        { branchId: string; nodes: readonly string[]; changes: number; textTakenBack: boolean }
      >();
      if (commandIds.length === 0) return found;
      const ids = commandIds as CommandId[];
      const outcomes = await db()
        .select({ id: commandRows.id, outcome: commandRows.outcome })
        .from(commandRows)
        .where(inArray(commandRows.id, ids));
      // The branch the Apply ran on: its tree half's row, or a text effect's draft.
      const branchOf = new Map<string, string>();
      for (const row of await db()
        .select({ id: applyCommandTrees.commandId, branchId: applyCommandTrees.branchId })
        .from(applyCommandTrees)
        .where(inArray(applyCommandTrees.commandId, ids)))
        branchOf.set(row.id, row.branchId);
      const textOnly = ids.filter((id) => !branchOf.has(id));
      if (textOnly.length)
        for (const row of await db()
          .selectDistinctOn([applyCommandEffects.commandId], {
            id: applyCommandEffects.commandId,
            branchId: documentDrafts.branchId,
          })
          .from(applyCommandEffects)
          .innerJoin(documentDrafts, eq(documentDrafts.id, applyCommandEffects.draftId))
          .where(inArray(applyCommandEffects.commandId, textOnly)))
          branchOf.set(row.id, row.branchId);
      // One effect row per text group the Apply landed, and the Applies with one not taken back.
      const groups = new Map<string, number>();
      const open = new Set<string>();
      for (const row of await db()
        .select({
          id: applyCommandEffects.commandId,
          unappliedBy: applyCommandEffects.unappliedBy,
        })
        .from(applyCommandEffects)
        .where(inArray(applyCommandEffects.commandId, ids))) {
        groups.set(row.id, (groups.get(row.id) ?? 0) + 1);
        if (row.unappliedBy === null) open.add(row.id);
      }
      for (const { id, outcome } of outcomes) {
        const branchId = branchOf.get(id);
        const result =
          outcome.status === "done" ? (outcome.result as Partial<ApplyClickResult>) : null;
        if (!branchId || result?.status !== "applied") continue;
        const items = result.items ?? [];
        const nodes = items.flatMap((item) =>
          item.tree?.landed || item.text?.landed ? [item.node] : [],
        );
        const changes = (groups.get(id) ?? 0) + items.filter((item) => item.tree?.landed).length;
        found.set(id, { branchId, nodes, changes, textTakenBack: groups.has(id) && !open.has(id) });
      }
      return found;
    },
    treeDraftStates: (query) =>
      query.model || !query.turnId
        ? Promise.resolve({ states: {}, appliedBy: {} })
        : treeInverse.draftStates(query.threadId, query.turnId),
    async treeSteps(query) {
      const tree = await treePlanOf(query);
      return {
        acting: tree.steps.length,
        taken: tree.taken.length + tree.undoneByCard,
        stayed: tree.stayed,
      };
    },
    async readHistory(documentId) {
      return (await history([documentId])).map((part) => ({ ...part, disposition: "pending" }));
    },
    describePart(document, part) {
      const destination = document.destinationOf(part.origin);
      const doc =
        destination.kind === "draft" && destination.state === "active"
          ? (document.drafts.get(destination.draftId)?.doc ?? document.live)
          : document.live;
      let excerpt = document.excerptViews.get(doc);
      if (!excerpt) {
        excerpt = new Y.Doc({ gc: false });
        Y.applyUpdate(excerpt, Y.encodeStateAsUpdate(doc));
        document.excerptViews.set(doc, excerpt);
      }
      Y.applyUpdate(excerpt, part.update);
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
      if (!attempt.attempt) throw new ReversalConflictError();
      const scope = attempt.attempt;
      await testHook("inverse.beforeCommitScope");
      // Off every lock: each plan's parts with provenance on its attempt-local view.
      const planned = new Map(plans.map((plan) => [plan, planInverseDocument(plan, query)]));
      const documents = [...planned.values()];
      const handles: string[] = [];
      const deliveries: (() => Promise<void>)[] = [];
      const skips: TurnInverseSkip[] = [];
      // Off every lock: the tree receipts the reply left, which lists and Works they write.
      const tree = kind === "revert" ? NO_TREE_STEPS : await treePlanOf(query);
      const grants = await admitInverse(sequence, query, userId, tree.documents);
      const works = {
        drafts: attempt.draftIds,
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
        // What each plan was computed against is still what the documents hold.
        await confirmCapture(query, attempt);
        const runText = async () => {
          for (const { plan, step } of sequence) {
            const entry = planned.get(plan);
            if (!entry) throw new Error("A step's plan is not among the commit's plans");
            const outcome = await commitTextStep(entry, step, userId, query);
            if (typeof outcome === "string") {
              if (outcome) handles.push(outcome);
            } else skips.push(outcome);
          }
        };
        const runTree = async () => {
          if (!tree.steps.length && !tree.stayed.length && !tree.taken.length && !tree.undoneByCard)
            return;
          const now = await treePlanOf(query);
          const locked = new Set(tree.lists.map((list) => JSON.stringify(list)));
          if (now.lists.some((list) => !locked.has(JSON.stringify(list))))
            throw new InverseAttemptMiss();
          // The owners moved since the locks were chosen: past their order, so the caller runs again.
          const owners = { workIds: now.owners.works, lineageRootIds: now.owners.lineages };
          if (!within(effect, owners)) throw new TreeOwnersMoved([], owners);
          const done = await treeInverse.run(now, {
            threadId: query.threadId,
            userId,
          });
          treeReversed = done.reversed;
          skips.push(...done.skips);
        };
        // A node a reply made is taken back once the text written into it is.
        await runText();
        await runTree();
        for (const entry of documents) await settleDocument(entry, kind, query, deliveries);
      };
      const admitted = await runEditAdmission({
        fileAccess: input.fileAccess,
        grants,
        workProjection: input.workProjection,
        works,
        commitScope: (operation) => scope.commit(operation),
        acquireMutationScope: async () => {
          // The lists' keys come before every document key (the order in collab's CONTEXT.md).
          if (tree.lists.length) await input.treeLists.lock(tree.lists);
          for (const id of [...attempt.ids].sort()) await lockDocumentMutation(db(), id);
        },
        operation,
      });
      if (!admitted.ok) throw refusalOrMiss(admitted.refusal);
      attempt.deliveries.push(...deliveries);
      return {
        handles,
        updates: documents.flatMap((entry) => entry.updates.map(({ update }) => update)),
        skips,
        treeReversed,
        reversed: new Map(documents.map((entry) => [entry.documentId, entry.reversed])),
        outcomes: documents.flatMap((entry) => entry.outcomes),
        cut: documents.length === 1 ? documents[0]?.cut : undefined,
      };
    },
  };

  async function admitInverse(
    sequence: readonly { plan: PreparedDocumentInverse; step: InverseStep }[],
    query: TurnInverseQuery,
    userId: UserId | undefined,
    treeDocuments: readonly { documentId: string; branchId: BranchId | null; restore: boolean }[],
  ): Promise<FileGrant<"edit">[] | null> {
    const principal = query.principal ?? (userId ? { accountId: userId } : undefined);
    // Every inverse supplies its principal explicitly; an absent one here means a composition
    // bug, not live routing.
    if (!principal) return null;
    const requirements = new Map<
      string,
      { documentId: DocumentId; branchId: BranchId | null; restore: boolean }
    >();
    for (const { plan, step } of sequence) {
      const documentId = plan.document.documentId;
      const branchId = step.destination.kind === "draft" ? step.destination.branchId : null;
      requirements.set(`${documentId}:${branchId ?? "live"}:content`, {
        documentId,
        branchId,
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
          ? {
              kind: "draft",
              documentId: requirement.documentId,
              owner: holder.owner,
            }
          : requirement.restore
            ? { kind: "restore", documentId: requirement.documentId }
            : { kind: "document", documentId: requirement.documentId },
        holder
          ? { kind: "draft", owner: holder.owner, ownerHandle: holder.handle }
          : { kind: "live" },
        "edit",
      );
      if (isFileAccessDenied(grant)) throw refusalOrMiss(new FileEditRefusedError([grant]));
      grants.push(grant);
    }
    return grants;
  }

  /**
   * The one recorder of a committed inverse step: who made it (the model's chat and reply with
   * its write ordinal, stamped on the draft journal rows it wrote; or the writer), its action,
   * the receipts it committed, and its count where it landed. Returns the model's handle.
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
   * One step inside the commit scope: a live step's parts written to Live's journal, or a draft's
   * content step, then its row (`recordStep`).
   */
  async function commitTextStep(
    entry: PlannedInverse,
    step: InverseStep,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string> {
    if (step.kind === "content") return commitContentStep(entry, step, userId, query);
    const { plan } = entry;
    const document = plan.document;
    const parts = entry.edits.get(step.edit);
    if (!parts) throw new Error("A text step was not planned with its document");
    const receipts = [];
    for (const part of parts)
      receipts.push({
        ...part,
        origin: {
          kind: "live" as const,
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
        },
      });
    entry.committed.push(step.edit);
    entry.updates.push(...parts.map((part) => ({ draftId: null, update: part.update })));
    return recordStep(entry, step, { draftId: null, branchId: null, receipts }, userId, query);
  }

  /**
   * A drafted original's Undo, as an append under the draft's hold: each of its changes that
   * still stands in the committed text is taken out, and one receipt of kind `undo` names the parts
   * it took. A change that stopped standing between the capture and the hold is left whole.
   */
  async function commitContentStep(
    entry: PlannedInverse,
    step: Extract<InverseStep, { kind: "content" }>,
    userId: UserId | undefined,
    query: TurnInverseQuery,
  ): Promise<string> {
    const { draftId, branchId } = step.destination;
    const taken = new Set<StoredInversePart>();
    let appended: Uint8Array[] = [];
    // The model's inverse is an edit on its stack: it takes the next write ordinal, as a write does.
    const wId = query.model
      ? await input.journal.reserveWriteOrdinal(entry.documentId, query.threadId)
      : undefined;
    const base = await input.draftCoordinator.loadBase(draftId);
    const write = input.draftCoordinator.prepareAppend(base, [], {
      work: "active",
      serverRow: () => ({
        threadId: query.model ? query.threadId : null,
        turnId: query.model ? query.turnId : null,
        actorUserId: userId ?? null,
        wId,
        toolCallId: query.toolCallId,
        ...(query.model && query.responseIdentity
          ? { updateMeta: { authoringResponseId: query.responseIdentity.modelResponseId } }
          : {}),
        inverse: {
          kind: step.actionKind,
          actionId: step.actionId,
          targets: [...taken].map((part) => ({ editId: part.editId, ordinal: part.ordinal })),
        },
      }),
      authorServerRows(prefix) {
        const fragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
        const out = takeOutStanding(readBlocks(fragment, draftSchema), step.parts);
        for (const part of out.taken) taken.add(part);
        if (!taken.size) return [];
        appended = captureMutationUpdates(prefix, () =>
          prefix.transact(() => writeBlocks(fragment, draftSchema, out.text)),
        );
        return appended;
      },
    });
    try {
      const wrote = await write.persist();
      write.transfer();
      if (wrote) {
        const cut = write.cut();
        entry.cut = { before: cut.beforeState, after: cut.afterState };
        entry.updates.push(...appended.map((update) => ({ draftId, update })));
        entry.contentDrafts.add(draftId);
        count(entry, branchId, taken.size);
        entry.outcomes.push({ documentId: entry.documentId, branchId, draftId });
      }
    } finally {
      write.dispose();
    }
    return wId === undefined || !taken.size ? "" : editHandle(wId);
  }

  /** After every step: the document's delivery. */
  async function settleDocument(
    entry: PlannedInverse,
    kind: "undo" | "revert",
    query: TurnInverseQuery,
    deliveries: (() => Promise<void>)[],
  ): Promise<void> {
    const { plan } = entry;
    const document = plan.document;
    const landed = new Set<string | null>([
      ...entry.updates.map(({ draftId }) => draftId),
      ...entry.contentDrafts,
    ]);
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
          branchId: [...landed]
            .map((draftId) =>
              draftId ? document.drafts.get(draftId)?.documentDraft.branchId : undefined,
            )
            .find(Boolean),
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
