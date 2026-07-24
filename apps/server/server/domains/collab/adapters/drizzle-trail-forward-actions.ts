/** Journal-first forward Restore/Delete-again actions over retained trail evidence. */

import type { AgentEditCodec } from "@meridian/agent-edit";
import {
  type DocumentCoordinator,
  decodeNavigationPosition,
  getBlockItemId,
  isDocumentNotFoundError,
  type LiveBlockRangeTarget,
  toDocHandle,
  toRef,
  validateLiveBlockRange,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type {
  TrailForwardAction,
  TrailForwardActionResult,
  TrailForwardActionStateV1,
} from "@meridian/contracts";
import type { Database } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  changeTrailShells,
  documentYjsUpdates,
} from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import type { DocumentAccessPort } from "../../../lib/document-access.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import {
  applyCommittedUpdateAtFingerprint,
  fullStateFingerprint,
} from "../domain/branch-push-transition.js";
import { parseTrailChangesV1, type TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { allocateDocumentAdmission } from "./drizzle-document-authority-head.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";

type TerminalForwardActionResult = { status: "anchor_unavailable" } | { status: "retry_exhausted" };

export function createDrizzleTrailForwardActions(input: {
  db: Database;
  documentAccess: Pick<DocumentAccessPort, "documentAccessState">;
  coordinator: DocumentCoordinator;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}) {
  return {
    async apply(actionInput: {
      threadId: string;
      trailId: string;
      changeId: string;
      action: TrailForwardAction;
      userId: string;
    }): Promise<TrailForwardActionResult> {
      const detail = await loadAuthorizedChange(input.db, input.documentAccess, actionInput);
      if (!detail) return { status: "anchor_unavailable" };
      const durableState = detail.change.forwardActions?.[actionInput.action];
      if (durableState?.status === "applied") return { status: "already_applied" };
      if (durableState?.status === "settled") return terminalResult(durableState.outcome);

      try {
        return await input.coordinator.withDocument(detail.documentId, async (liveDoc) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const committed = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const locked = await loadAuthorizedChange(
                tx,
                input.documentAccess,
                actionInput,
                true,
              );
              if (!locked) return { status: "anchor_unavailable" as const };
              const state = locked.change.forwardActions?.[actionInput.action];
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
              const result = await planAndPersistTrailForwardAction({
                liveDoc,
                change: locked.change,
                action: actionInput.action,
                model: input.model,
                codec: input.codec,
                persist: async (intent) => {
                  persistedIntent = intent;
                  await updateActionState(tx, {
                    ...actionInput,
                    documentId: detail.documentId,
                    changes: locked.changes,
                    state: encodeIntent(intent),
                  });
                },
              });
              if (result === "anchor_unavailable") {
                await updateActionState(tx, {
                  ...actionInput,
                  documentId: detail.documentId,
                  changes: locked.changes,
                  state: { status: "settled", outcome: "anchor_unavailable" },
                });
                return { status: "anchor_unavailable" as const };
              }
              if (result === "live_changed") {
                if (!persistedIntent) throw new Error("Forward action intent was not persisted");
                if (attempt === 2) {
                  await updateActionState(tx, {
                    ...actionInput,
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

            const alreadyApplied = updateAlreadyApplied(liveDoc, committed.update);
            if (!alreadyApplied) {
              const applied = applyCommittedTrailForwardAction({
                liveDoc,
                update: committed.update,
                expectedLiveStateHash: committed.expectedLiveStateHash,
                liveOrigin: {
                  type: "user",
                  userId: actionInput.userId,
                  reason: `trail-${actionInput.action}`,
                },
              });
              if (applied === "live_changed") {
                if (attempt < 2) continue;
                return await settleTerminalAction(
                  input.db,
                  input.documentAccess,
                  { ...actionInput, documentId: detail.documentId },
                  "retry_exhausted",
                );
              }
            }

            const finalized = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const locked = await loadAuthorizedChange(
                tx,
                input.documentAccess,
                actionInput,
                true,
              );
              const state = locked?.change.forwardActions?.[actionInput.action];
              if (!locked) return "anchor_unavailable" as const;
              if (state?.status === "settled") return state.outcome;
              if (state?.status === "applied") return "already_applied" as const;
              if (state?.status !== "committed" || !sameIntent(state, committed)) {
                if (attempt === 2 && state?.status === "committed") {
                  await updateActionState(tx, {
                    ...actionInput,
                    documentId: detail.documentId,
                    changes: locked.changes,
                    state: { status: "settled", outcome: "retry_exhausted" },
                  });
                  return "retry_exhausted" as const;
                }
                return "retry" as const;
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
                  actorUserId: actionInput.userId as never,
                })
                .returning({ id: documentYjsUpdates.id });
              if (!journalRow) throw new Error("Failed to persist trail forward action");
              await updateActionState(tx, {
                ...actionInput,
                documentId: detail.documentId,
                changes: locked.changes,
                state: { status: "applied", updateId: journalRow.id },
              });
              return "applied" as const;
            });
            if (finalized === "retry") continue;
            if (finalized === "anchor_unavailable" || finalized === "retry_exhausted") {
              return { status: finalized };
            }
            return {
              status:
                alreadyApplied || finalized === "already_applied" ? "already_applied" : "applied",
            };
          }
          return await settleTerminalAction(
            input.db,
            input.documentAccess,
            { ...actionInput, documentId: detail.documentId },
            "retry_exhausted",
          );
        });
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) {
          return await settleTerminalAction(
            input.db,
            input.documentAccess,
            { ...actionInput, documentId: detail.documentId },
            "anchor_unavailable",
          );
        }
        throw cause;
      }
    },
  };
}

function terminalResult(
  outcome: Extract<TrailForwardActionStateV1, { status: "settled" }>["outcome"],
): TerminalForwardActionResult {
  return outcome === "anchor_unavailable"
    ? { status: "anchor_unavailable" }
    : { status: "retry_exhausted" };
}

async function settleTerminalAction(
  db: Database,
  documentAccess: Pick<DocumentAccessPort, "documentAccessState">,
  actionInput: {
    threadId: string;
    trailId: string;
    changeId: string;
    action: TrailForwardAction;
    documentId: string;
    userId: string;
  },
  outcome: Extract<TrailForwardActionStateV1, { status: "settled" }>["outcome"],
): Promise<TrailForwardActionResult> {
  return db.transaction(async (tx) => {
    await lockDocumentMutation(tx, actionInput.documentId);
    const locked = await loadAuthorizedChange(tx, documentAccess, actionInput, true);
    if (!locked) return { status: "anchor_unavailable" };
    const state = locked.change.forwardActions?.[actionInput.action];
    if (state?.status === "applied") return { status: "already_applied" };
    if (state?.status === "settled") return { status: state.outcome };
    await updateActionState(tx, {
      ...actionInput,
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
export async function planAndPersistTrailForwardAction(input: {
  liveDoc: Y.Doc;
  change: TrailChangeV1;
  action: TrailForwardAction;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
  persist: (intent: { update: Uint8Array; expectedLiveStateHash: string }) => Promise<void>;
}): Promise<
  { update: Uint8Array; expectedLiveStateHash: string } | "anchor_unavailable" | "live_changed"
> {
  const liveBefore = liveStateFingerprint(input.liveDoc);
  const planned = planTrailForwardAction(input);
  if (!planned) return "anchor_unavailable";
  await input.persist({ update: planned.update, expectedLiveStateHash: liveBefore });

  const liveUnchanged = liveBefore === liveStateFingerprint(input.liveDoc);
  if (!liveUnchanged) return "live_changed";
  return { update: planned.update, expectedLiveStateHash: liveBefore };
}

/** Applies durable intent after commit; replaying the same Yjs update is idempotent. */
export function applyCommittedTrailForwardAction(input: {
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
}): TrailForwardActionStateV1 {
  return {
    status: "committed",
    update: Buffer.from(intent.update).toString("base64"),
    expectedLiveStateHash: intent.expectedLiveStateHash,
  };
}

function decodeIntent(state: Extract<TrailForwardActionStateV1, { status: "committed" }>) {
  return {
    update: new Uint8Array(Buffer.from(state.update, "base64")),
    expectedLiveStateHash: state.expectedLiveStateHash,
  };
}

function sameIntent(
  state: Extract<TrailForwardActionStateV1, { status: "committed" }>,
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

async function updateActionState(
  tx: Pick<DrizzleDb, "update">,
  input: {
    trailId: string;
    changeId: string;
    action: TrailForwardAction;
    documentId: string;
    changes: TrailChangeV1[];
    state: TrailForwardActionStateV1;
  },
) {
  const changes = input.changes.map((change) =>
    change.changeId === input.changeId
      ? {
          ...change,
          forwardActions: { ...change.forwardActions, [input.action]: input.state },
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

async function loadAuthorizedChange(
  db: Pick<DrizzleDb, "select">,
  documentAccess: Pick<DocumentAccessPort, "documentAccessState">,
  input: { threadId: string; trailId: string; changeId: string; userId: string },
  lock = false,
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
    );
  const authorizedDocumentIds = (
    await Promise.all(
      documentRows.map(async ({ documentId }) =>
        (await documentAccess.documentAccessState(input.userId as never, documentId)) ===
        "available"
          ? documentId
          : null,
      ),
    )
  ).filter((documentId): documentId is NonNullable<typeof documentId> => documentId !== null);
  if (authorizedDocumentIds.length === 0) return null;

  let query = db
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
  if (lock) query = query.for("update") as typeof query;
  for (const row of await query) {
    const changes = parseTrailChangesV1(row.changes);
    const change = changes.find((candidate) => candidate.changeId === input.changeId);
    if (change) return { documentId: row.documentId, changes, change };
  }
  return null;
}

export function planTrailForwardAction(input: {
  liveDoc: Y.Doc;
  change: TrailChangeV1;
  action: TrailForwardAction;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): { update: Uint8Array } | null {
  const expectedKind = input.action === "restore" ? "sweep" : "resurrection";
  if (input.change.writerProtection?.kind !== expectedKind) return null;
  const body = input.change.writerProtection.body;
  if (body.status !== "available") return null;
  const scratch = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.liveDoc));
    const before = Y.encodeStateVector(scratch);
    if (input.action === "restore") {
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
    } else {
      if (input.change.navigation.kind !== "live_block_range") return null;
      const target = validateLiveBlockRange({
        doc: scratch,
        target: input.change.navigation as LiveBlockRangeTarget,
      });
      if (!target) return null;
      input.model.deleteBlock(toDocHandle(scratch), toRef(target.block));
    }
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
  // A sweep can fresh-replace a block while retaining its element identity. If
  // projection could not capture a deletion boundary, that canonical identity
  // is still a document-scoped durable anchor; restore immediately before it.
  const identity = change.afterBlockIdentity;
  if (!identity || identity.documentId !== change.documentId) return null;
  const index = root.toArray().findIndex((value) => {
    if (!(value instanceof Y.XmlElement)) return false;
    const id = getBlockItemId(value);
    return id.clientID === identity.clientID && id.clock === identity.clock;
  });
  return index >= 0 ? index : null;
}
