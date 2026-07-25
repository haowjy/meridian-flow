/** Journal-first Restore actions over retained trail evidence. */

import type { AgentEditCodec } from "@meridian/agent-edit/integration";
import {
  type DocumentCoordinator,
  decodeNavigationPosition,
  getBlockItemId,
  isDocumentNotFoundError,
  toDocHandle,
  toRef,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { TrailRestoreResult, TrailRestoreStateV1 } from "@meridian/contracts";
import type { UserId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  changeTrailShells,
  documents,
  documentYjsUpdates,
} from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  applyCommittedUpdateAtFingerprint,
  fullStateFingerprint,
} from "../domain/branch-push-transition.js";
import type { DurableProjectionSerializer } from "../domain/ports/durable-projection.js";
import {
  bodyFromHashline,
  parseTrailChangesV1,
  type TrailChangeV1,
} from "../domain/trail-read-kernel.js";
import { allocateDocumentAdmission } from "./drizzle-document-authority-head.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";

type TerminalRestoreResult = { status: "anchor_unavailable" } | { status: "retry_exhausted" };

export type TrailDocumentAccess = {
  lockDocumentAccessState(
    tx: Pick<DrizzleDb, "select">,
    userId: UserId,
    documentId: string,
  ): Promise<"available" | "deleted" | null>;
};

export function createDrizzleTrailRestore(input: {
  db: Database;
  documentAccess: TrailDocumentAccess;
  coordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  durableProjectionSerializer: DurableProjectionSerializer;
}) {
  return {
    async restore(restoreInput: {
      threadId: string;
      trailId: string;
      changeId: string;
      userId: string;
    }): Promise<TrailRestoreResult> {
      const detail = await input.db.transaction((tx) =>
        loadLockedAuthorizedChange(tx, input.documentAccess, restoreInput),
      );
      if (!detail) return { status: "anchor_unavailable" };
      const durableState = detail.change.restore;
      if (durableState?.status === "applied") return { status: "already_applied" };
      if (durableState?.status === "settled") return terminalResult(durableState.outcome);

      try {
        return await input.coordinator.withDocument(detail.documentId, async (liveDoc) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const committed = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const accessState = await input.documentAccess.lockDocumentAccessState(
                tx,
                restoreInput.userId as UserId,
                detail.documentId,
              );
              if (accessState !== "available") return { status: "anchor_unavailable" as const };
              const locked = await loadChangeForDocument(tx, restoreInput, detail.documentId, true);
              if (!locked) return { status: "anchor_unavailable" as const };
              const state = locked.change.restore;
              if (state?.status === "applied") return { status: "already_applied" as const };
              if (state?.status === "settled") return terminalResult(state.outcome);
              if (state?.status === "committed") {
                const intent = decodeIntent(state);
                if (
                  updateAlreadyApplied(liveDoc, intent.update) ||
                  intent.expectedLiveStateHash === liveStateFingerprint(liveDoc)
                ) {
                  return { status: "committed" as const, ...intent };
                }
              }

              let persistedIntent:
                | { update: Uint8Array; expectedLiveStateHash: string }
                | undefined;
              const result = await planAndPersistTrailRestore({
                liveDoc,
                change: locked.change,
                model: input.model,
                codec: input.codec,
                persist: async (intent) => {
                  persistedIntent = intent;
                  await updateRestoreState(tx, {
                    ...restoreInput,
                    documentId: detail.documentId,
                    changes: locked.changes,
                    state: encodeIntent(intent),
                  });
                },
              });
              if (result === "anchor_unavailable") {
                await updateRestoreState(tx, {
                  ...restoreInput,
                  documentId: detail.documentId,
                  changes: locked.changes,
                  state: { status: "settled", outcome: "anchor_unavailable" },
                });
                return { status: "anchor_unavailable" as const };
              }
              if (result === "live_changed") {
                if (!persistedIntent) throw new Error("Forward action intent was not persisted");
                if (attempt === 2) {
                  await updateRestoreState(tx, {
                    ...restoreInput,
                    documentId: detail.documentId,
                    changes: locked.changes,
                    state: { status: "settled", outcome: "retry_exhausted" },
                  });
                  return { status: "retry_exhausted" as const };
                }
                return { status: "committed" as const, ...persistedIntent };
              }
              return { status: "committed" as const, ...result };
            });
            if (
              committed.status === "anchor_unavailable" ||
              committed.status === "retry_exhausted" ||
              committed.status === "already_applied"
            ) {
              return committed;
            }

            const finalized = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const accessState = await input.documentAccess.lockDocumentAccessState(
                tx,
                restoreInput.userId as UserId,
                detail.documentId,
              );
              if (accessState !== "available") return "anchor_unavailable" as const;
              const locked = await loadChangeForDocument(tx, restoreInput, detail.documentId, true);
              if (!locked) return "anchor_unavailable" as const;
              const state = locked.change.restore;
              if (state?.status === "settled") return state.outcome;
              if (state?.status === "applied") return "already_applied" as const;
              if (state?.status !== "committed" || !sameIntent(state, committed)) {
                if (attempt === 2 && state?.status === "committed") {
                  await updateRestoreState(tx, {
                    ...restoreInput,
                    documentId: detail.documentId,
                    changes: locked.changes,
                    state: { status: "settled", outcome: "retry_exhausted" },
                  });
                  return "retry_exhausted" as const;
                }
                return "retry" as const;
              }
              const alreadyApplied = updateAlreadyApplied(liveDoc, committed.update);
              let projectedDoc: Y.Doc = liveDoc;
              let scratch: Y.Doc | undefined;
              if (!alreadyApplied) {
                scratch = new Y.Doc({ gc: false });
                Y.applyUpdate(scratch, Y.encodeStateAsUpdate(liveDoc));
                const projected = applyCommittedTrailRestore({
                  liveDoc: scratch,
                  update: committed.update,
                  expectedLiveStateHash: committed.expectedLiveStateHash,
                  liveOrigin: {
                    type: "user",
                    userId: restoreInput.userId,
                    reason: "trail-restore",
                  },
                });
                if (projected === "live_changed") {
                  scratch.destroy();
                  if (attempt === 2) {
                    await updateRestoreState(tx, {
                      ...restoreInput,
                      documentId: detail.documentId,
                      changes: locked.changes,
                      state: { status: "settled", outcome: "retry_exhausted" },
                    });
                    return "retry_exhausted" as const;
                  }
                  return "retry" as const;
                }
                projectedDoc = scratch;
              }
              let markdownProjection: string;
              try {
                markdownProjection = await input.durableProjectionSerializer.serializeDocument(
                  detail.documentId as never,
                  projectedDoc,
                );
              } finally {
                scratch?.destroy();
              }
              if (!alreadyApplied) {
                const applied = applyCommittedTrailRestore({
                  liveDoc,
                  update: committed.update,
                  expectedLiveStateHash: committed.expectedLiveStateHash,
                  liveOrigin: {
                    type: "user",
                    userId: restoreInput.userId,
                    reason: "trail-restore",
                  },
                });
                if (applied === "live_changed") {
                  if (attempt === 2) {
                    await updateRestoreState(tx, {
                      ...restoreInput,
                      documentId: detail.documentId,
                      changes: locked.changes,
                      state: { status: "settled", outcome: "retry_exhausted" },
                    });
                    return "retry_exhausted" as const;
                  }
                  return "retry" as const;
                }
              }
              const authorityHead = await allocateDocumentAdmission(tx, detail.documentId);
              const [journalRow] = await tx
                .insert(documentYjsUpdates)
                .values({
                  documentId: detail.documentId as never,
                  authorityId: authorityHead.authorityId,
                  authorityGeneration: authorityHead.generation,
                  admissionSequence: authorityHead.admissionSequence,
                  batchOrdinal: 0,
                  updateData: Buffer.from(committed.update),
                  originType: "human",
                  actorUserId: restoreInput.userId as never,
                })
                .returning({ id: documentYjsUpdates.id });
              if (!journalRow) throw new Error("Failed to persist trail Restore");
              await tx
                .update(documents)
                .set({ markdownProjection, updatedAt: new Date() })
                .where(eq(documents.id, detail.documentId as never));
              await updateRestoreState(tx, {
                ...restoreInput,
                documentId: detail.documentId,
                changes: locked.changes,
                state: { status: "applied", updateId: journalRow.id },
              });
              return alreadyApplied ? ("already_applied" as const) : ("applied" as const);
            });
            if (finalized === "retry") continue;
            if (finalized === "anchor_unavailable" || finalized === "retry_exhausted") {
              return { status: finalized };
            }
            return { status: finalized };
          }
          return await settleTerminalRestore(
            input.db,
            input.documentAccess,
            { ...restoreInput, documentId: detail.documentId },
            "retry_exhausted",
          );
        });
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) {
          return await settleTerminalRestore(
            input.db,
            input.documentAccess,
            { ...restoreInput, documentId: detail.documentId },
            "anchor_unavailable",
          );
        }
        throw cause;
      }
    },
  };
}

function terminalResult(
  outcome: Extract<TrailRestoreStateV1, { status: "settled" }>["outcome"],
): TerminalRestoreResult {
  return outcome === "anchor_unavailable"
    ? { status: "anchor_unavailable" }
    : { status: "retry_exhausted" };
}

async function settleTerminalRestore(
  db: Database,
  documentAccess: TrailDocumentAccess,
  restoreInput: {
    threadId: string;
    trailId: string;
    changeId: string;
    documentId: string;
    userId: string;
  },
  outcome: Extract<TrailRestoreStateV1, { status: "settled" }>["outcome"],
): Promise<TrailRestoreResult> {
  return db.transaction(async (tx) => {
    await lockDocumentMutation(tx, restoreInput.documentId);
    const accessState = await documentAccess.lockDocumentAccessState(
      tx,
      restoreInput.userId as UserId,
      restoreInput.documentId,
    );
    if (accessState !== "available") return { status: "anchor_unavailable" };
    const locked = await loadChangeForDocument(tx, restoreInput, restoreInput.documentId, true);
    if (!locked) return { status: "anchor_unavailable" };
    const state = locked.change.restore;
    if (state?.status === "applied") return { status: "already_applied" };
    if (state?.status === "settled") return { status: state.outcome };
    await updateRestoreState(tx, {
      ...restoreInput,
      changes: locked.changes,
      state: { status: "settled", outcome },
    });
    return { status: outcome };
  });
}

/**
 * Plans and persists only after the mutation locks are held. It never mutates
 * the live document: the caller must wait for its transaction to commit first.
 */
export async function planAndPersistTrailRestore(input: {
  liveDoc: Y.Doc;
  change: TrailChangeV1;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  persist: (intent: { update: Uint8Array; expectedLiveStateHash: string }) => Promise<void>;
}): Promise<
  { update: Uint8Array; expectedLiveStateHash: string } | "anchor_unavailable" | "live_changed"
> {
  const liveBefore = liveStateFingerprint(input.liveDoc);
  const planned = planTrailRestore(input);
  if (!planned) return "anchor_unavailable";
  await input.persist({ update: planned.update, expectedLiveStateHash: liveBefore });

  const liveUnchanged = liveBefore === liveStateFingerprint(input.liveDoc);
  if (!liveUnchanged) return "live_changed";
  return { update: planned.update, expectedLiveStateHash: liveBefore };
}

/** Applies durable intent after commit; replaying the same Yjs update is idempotent. */
export function applyCommittedTrailRestore(input: {
  liveDoc: Y.Doc;
  update: Uint8Array;
  expectedLiveStateHash: string;
  liveOrigin: unknown;
}): "applied" | "live_changed" {
  return applyCommittedUpdateAtFingerprint({
    liveDoc: input.liveDoc,
    update: input.update,
    expectedFingerprint: input.expectedLiveStateHash,
    origin: input.liveOrigin,
  });
}

function updateAlreadyApplied(liveDoc: Y.Doc, update: Uint8Array): boolean {
  const scratch = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(liveDoc));
    const before = Y.encodeStateAsUpdate(scratch);
    Y.applyUpdate(scratch, update);
    return equalBytes(before, Y.encodeStateAsUpdate(scratch));
  } finally {
    scratch.destroy();
  }
}

function encodeIntent(intent: {
  update: Uint8Array;
  expectedLiveStateHash: string;
}): TrailRestoreStateV1 {
  return {
    status: "committed",
    update: Buffer.from(intent.update).toString("base64"),
    expectedLiveStateHash: intent.expectedLiveStateHash,
  };
}

function decodeIntent(state: Extract<TrailRestoreStateV1, { status: "committed" }>) {
  return {
    update: new Uint8Array(Buffer.from(state.update, "base64")),
    expectedLiveStateHash: state.expectedLiveStateHash,
  };
}

function sameIntent(
  state: Extract<TrailRestoreStateV1, { status: "committed" }>,
  intent: { update: Uint8Array; expectedLiveStateHash: string },
): boolean {
  const decoded = decodeIntent(state);
  return (
    equalBytes(decoded.update, intent.update) &&
    decoded.expectedLiveStateHash === intent.expectedLiveStateHash
  );
}

export function liveStateFingerprint(doc: Y.Doc): string {
  return fullStateFingerprint(doc);
}

async function updateRestoreState(
  tx: Pick<DrizzleDb, "update">,
  input: {
    trailId: string;
    changeId: string;
    documentId: string;
    changes: TrailChangeV1[];
    state: TrailRestoreStateV1;
  },
) {
  const changes = input.changes.map((change) =>
    change.changeId === input.changeId
      ? {
          ...change,
          restore: input.state,
        }
      : change,
  );
  await tx
    .update(changeTrailDocumentDetails)
    .set({ changes, updatedAt: new Date() })
    .where(
      and(
        eq(changeTrailDocumentDetails.trailId, input.trailId),
        eq(changeTrailDocumentDetails.documentId, input.documentId as never),
      ),
    );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function loadChangeForDocument(
  db: Pick<DrizzleDb, "select">,
  input: { threadId: string; trailId: string; changeId: string },
  documentId: string,
  lock = false,
): Promise<{ documentId: string; changes: TrailChangeV1[]; change: TrailChangeV1 } | null> {
  let query = db
    .select({
      documentId: changeTrailDocumentDetails.documentId,
      changes: changeTrailDocumentDetails.changes,
    })
    .from(changeTrailDocumentDetails)
    .innerJoin(changeTrailShells, eq(changeTrailShells.id, changeTrailDocumentDetails.trailId))
    .where(
      and(
        eq(changeTrailDocumentDetails.trailId, input.trailId),
        eq(changeTrailDocumentDetails.documentId, documentId as never),
        eq(changeTrailShells.threadId, input.threadId as never),
      ),
    );
  if (lock) query = query.for("update") as typeof query;
  const [row] = await query;
  if (!row) return null;
  const changes = parseTrailChangesV1(row.changes);
  const change = changes.find((candidate) => candidate.changeId === input.changeId);
  return change ? { documentId: row.documentId, changes, change } : null;
}

async function loadLockedAuthorizedChange(
  db: Pick<DrizzleDb, "select">,
  documentAccess: TrailDocumentAccess,
  input: { threadId: string; trailId: string; changeId: string; userId: string },
): Promise<{ documentId: string; changes: TrailChangeV1[]; change: TrailChangeV1 } | null> {
  const documentRows = await db
    .select({ documentId: changeTrailDocumentDetails.documentId })
    .from(changeTrailDocumentDetails)
    .innerJoin(changeTrailShells, eq(changeTrailShells.id, changeTrailDocumentDetails.trailId))
    .where(
      and(
        eq(changeTrailDocumentDetails.trailId, input.trailId),
        eq(changeTrailShells.threadId, input.threadId as never),
      ),
    )
    .orderBy(asc(changeTrailDocumentDetails.documentId));
  const authorizedDocumentIds: string[] = [];
  for (const { documentId } of documentRows) {
    const accessState = await documentAccess.lockDocumentAccessState(
      db,
      input.userId as UserId,
      documentId,
    );
    if (accessState === "available") authorizedDocumentIds.push(documentId);
  }
  if (authorizedDocumentIds.length === 0) return null;

  const query = db
    .select({
      documentId: changeTrailDocumentDetails.documentId,
      changes: changeTrailDocumentDetails.changes,
    })
    .from(changeTrailDocumentDetails)
    .where(
      and(
        eq(changeTrailDocumentDetails.trailId, input.trailId),
        inArray(changeTrailDocumentDetails.documentId, authorizedDocumentIds),
      ),
    );
  for (const row of await query) {
    const changes = parseTrailChangesV1(row.changes);
    const change = changes.find((candidate) => candidate.changeId === input.changeId);
    if (change) return { documentId: row.documentId, changes, change };
  }
  return null;
}

export function planTrailRestore(input: {
  liveDoc: Y.Doc;
  change: TrailChangeV1;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): { update: Uint8Array } | null {
  const body = bodyFromHashline(input.change.beforeText);
  if (body.status !== "available") return null;
  const scratch = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.liveDoc));
    const before = Y.encodeStateVector(scratch);
    const root = scratch.getXmlFragment("prosemirror");
    const index = restoreBoundaryIndex(scratch, input.change);
    if (index === null) return null;
    const previous = index > 0 ? root.get(index - 1) : null;
    if (previous !== null && !(previous instanceof Y.XmlElement)) return null;
    input.model.insertBlocks(
      toDocHandle(scratch),
      previous ? toRef(previous) : null,
      input.codec.parse(body.markdown),
    );
    return { update: Y.encodeStateAsUpdate(scratch, before) };
  } catch {
    return null;
  } finally {
    scratch.destroy();
  }
}

function restoreBoundaryIndex(doc: Y.Doc, change: TrailChangeV1): number | null {
  const root = doc.getXmlFragment("prosemirror");
  if (change.navigation.kind === "deletion_boundary") {
    const relative = decodeNavigationPosition(change.navigation.position);
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);
    return absolute?.type === root ? absolute.index : null;
  }
  // A replacement can retain its element identity. Restore immediately before
  // that durable document-scoped anchor when no deletion boundary was captured.
  const identity = change.afterBlockIdentity;
  if (!identity || identity.documentId !== change.documentId) return null;
  const index = root.toArray().findIndex((value) => {
    if (!(value instanceof Y.XmlElement)) return false;
    const id = getBlockItemId(value);
    return id.clientID === identity.clientID && id.clock === identity.clock;
  });
  return index >= 0 ? index : null;
}
