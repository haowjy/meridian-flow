/** Durable multi-document inverse admission; publishes only after the transaction commits. */
import {
  type DocumentCoordinator,
  editHandle,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates, textInRanges } from "@meridian/agent-edit/yjs-mutation";
import type { DocumentId } from "@meridian/contracts";
import {
  branchWriteJournal,
  type Database,
  documentBranches,
  documentEditParts,
  documentEdits,
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
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { confirmScopedEdits } from "../../../shared/edit-confirmation.js";
import { lockDraftBranchWorks } from "../../../shared/work-draft-lifecycle.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { BranchCoordinator, BranchStore } from "../domain/branch-coordinator.js";
import type { BranchCriticalSections } from "../domain/branch-critical-sections.js";
import { appendInverseRestorationFacts } from "../domain/provenance.js";
import {
  createTurnInverseService,
  type InverseDocument,
  type StoredInversePart,
  type TurnInverseQuery,
  type TurnInverseStore,
} from "../domain/turn-inverse-service.js";
import { recordDocumentEdit } from "./drizzle-document-edits.js";
import { refreshDraftEffect } from "./drizzle-draft-effect.js";
import { readTurnEditTargets } from "./drizzle-turn-edit-targets.js";

type Dependencies = {
  db: Database;
  journal: UpdateJournal;
  branches: BranchStore;
  coordinator: DocumentCoordinator;
  branchCoordinator: Pick<BranchCoordinator, "broadcastUpdate">;
  criticalSections: BranchCriticalSections;
  resolveDocumentUri(documentId: string): Promise<string | null>;
  refreshDocument(documentId: DocumentId): Promise<void>;
  flushLivePull(documentId: DocumentId): Promise<void>;
  notices: import("../domain/reversal-notices.js").TurnInverseNoticePort;
  /** Revert, rollback and mark-blocking change pending membership, so they publish through it. */
  workProjection: Pick<WorkProjectionMutation, "mutatePendingBranches">;
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
  const store: TurnInverseStore = {
    async withLockedDocuments(query, run) {
      return runInDrizzleTransaction(input.db, async () => {
        const ids = await selectedDocuments(query);
        // Only inverse policies take this lock. Apply never waits on it.
        for (const id of ids)
          await db().execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`document-inverse:${id}`},0::bigint))`,
          );
        const parts = await history(ids);
        const branchIds = [
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
        return input.criticalSections.withBranches(branchIds, async () => {
          const lockLive = async (index: number): Promise<Awaited<ReturnType<typeof run>>> => {
            const id = ids[index];
            if (id) return input.coordinator.withDocument(id, () => lockLive(index + 1));
            const frozen = await lockDraftBranchWorks(input.db, branchIds);
            for (const key of [...ids, ...branchIds].sort()) await lockDocumentMutation(db(), key);
            if (query.model) await confirmScopedEdits();
            const currentParts = await history(ids);
            const documents: InverseDocument[] = [];
            try {
              for (const documentId of ids) {
                const live = await materialize(documentId);
                const document: InverseDocument = {
                  documentId,
                  uri: (await input.resolveDocumentUri(documentId)) ?? documentId,
                  live,
                  history: currentParts.filter((part) => part.documentId === documentId),
                  drafts: new Map(),
                };
                documents.push(document);
                const drafts = new Map<
                  string,
                  InverseDocument["drafts"] extends ReadonlyMap<string, infer D> ? D : never
                >();
                for (const branchId of branchIds) {
                  const branch = await input.branches.getBranch(branchId);
                  if (!branch || branch.documentId !== documentId || branch.status !== "active")
                    continue;
                  const doc = new Y.Doc({ gc: false });
                  Y.applyUpdate(doc, branch.state);
                  // A draft action always includes the locked, current live cut.
                  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
                  const [name] = branch.workId
                    ? await db()
                        .select({ handle: works.handle })
                        .from(works)
                        .where(eq(works.id, branch.workId))
                    : [];
                  drafts.set(branchId, {
                    branch,
                    doc,
                    name: name?.handle ?? "No Work",
                    frozen: frozen.has(branchId),
                  });
                }
                document.drafts = drafts;
              }
              return await run(documents);
            } finally {
              for (const document of documents) {
                document.live.destroy();
                for (const draft of document.drafts.values()) draft.doc.destroy();
              }
            }
          };
          return lockLive(0);
        });
      });
    },
    async markBlocking(branchIds) {
      if (!branchIds.length) return;
      await input.workProjection.mutatePendingBranches(branchIds, async () => {
        await db()
          .update(documentBranches)
          .set({ blocking: true })
          .where(inArray(documentBranches.id, branchIds));
      });
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
      const handles: string[] = [];
      const mutate = async () => {
        for (const plan of plans) {
          const document = plan.document;
          const draft = plan.branchId ? document.drafts.get(plan.branchId) : undefined;
          const view = draft?.doc ?? document.live;
          const updates: Uint8Array[] = [];
          for (const edit of plan.computed.edits) {
            const receipts = [];
            for (const computedPart of edit.parts) {
              const client =
                Y.decodeUpdate(computedPart.update).structs[0]?.id.client ??
                allocateDocumentClient(view);
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
              const part = {
                ...computedPart,
                update: provenance.length
                  ? Y.mergeUpdates([computedPart.update, ...provenance])
                  : computedPart.update,
              };
              let origin: EditOrigin;
              if (draft) {
                const [row] = await db()
                  .insert(branchWriteJournal)
                  .values({
                    branchId: draft.branch.branchId,
                    generation: draft.branch.generation,
                    updateData: Buffer.from(part.update),
                    source: query.model ? "agent" : "writer",
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
                origin = {
                  kind: "pending",
                  branchId: draft.branch.branchId,
                  generation: draft.branch.generation,
                  rowId: row.id,
                };
              } else {
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
                origin = { kind: "live", seq };
              }
              receipts.push({ ...part, origin });
              updates.push(part.update);
            }
            const wId = query.model
              ? await input.journal.reserveWriteOrdinal(document.documentId, query.threadId)
              : undefined;
            if (wId !== undefined) {
              handles.push(editHandle(wId));
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
          if (draft && updates.length) {
            const [updated] = await db()
              .update(documentBranches)
              .set({
                state: Buffer.from(Y.encodeStateAsUpdate(view)),
                stateVector: Buffer.from(Y.encodeStateVector(view)),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(documentBranches.id, draft.branch.branchId),
                  eq(documentBranches.generation, draft.branch.generation),
                  eq(documentBranches.status, "active"),
                  eq(documentBranches.state, Buffer.from(draft.branch.state)),
                  eq(documentBranches.stateVector, Buffer.from(draft.branch.stateVector)),
                ),
              )
              .returning({ id: documentBranches.id });
            if (!updated) throw new Error("Inverse draft admission changed under its lock");
            await refreshDraftEffect(
              db(),
              draft.branch.branchId,
              Y.encodeStateAsUpdate(document.live),
            );
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
            if (rowIds.length)
              await db()
                .update(branchWriteJournal)
                .set({ status: "rollback_pending" })
                .where(
                  and(
                    inArray(branchWriteJournal.id, rowIds),
                    eq(branchWriteJournal.status, "active"),
                  ),
                );
          }
          if (!updates.length) continue;
          const publish = async () => {
            if (draft)
              input.branchCoordinator.broadcastUpdate({
                branchId: draft.branch.branchId,
                update: Y.mergeUpdates(updates),
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
          if (!deferUntilDrizzleCommit(publish)) await publish();
        }
      };
      const branchIds = plans.flatMap((plan) => (plan.branchId ? [plan.branchId] : []));
      await input.workProjection.mutatePendingBranches(branchIds, mutate);
      return handles;
    },
  };
  return createTurnInverseService(store);
}
