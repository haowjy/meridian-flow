/** Journal-first forward Restore/Delete-again actions over retained trail evidence. */

import { createHash } from "node:crypto";
import type { AgentEditCodec } from "@meridian/agent-edit";
import {
  type DocumentCoordinator,
  decodeNavigationPosition,
  isDocumentNotFoundError,
  type LiveBlockRangeTarget,
  toDocHandle,
  toRef,
  validateLiveBlockRange,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit";
import type { Database } from "@meridian/database";
import {
  changeTrailDocumentDetails,
  changeTrailShells,
  documentYjsUpdates,
} from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import * as Y from "yjs";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { TrailChangeV1, TrailForwardActionStateV1 } from "../domain/trail-read-kernel.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";

export type TrailForwardAction = "restore" | "delete-again";
export type TrailForwardActionResult =
  | { status: "applied" | "already_applied" }
  | { status: "anchor_unavailable" };

export function createDrizzleTrailForwardActions(input: {
  db: Database;
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
      const detail = await loadChange(input.db, actionInput);
      if (!detail) return { status: "anchor_unavailable" };

      try {
        return await input.coordinator.withDocument(detail.documentId, async (liveDoc) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const committed = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const locked = await loadChange(tx, actionInput, true);
              if (!locked) return { status: "anchor_unavailable" as const };
              const state = locked.change.forwardActions?.[actionInput.action];
              if (state?.status === "applied") return { status: "already_applied" as const };
              if (state?.status === "settled") return { status: state.outcome };
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
                return { status: "committed" as const, ...persistedIntent };
              }
              return { status: "committed" as const, ...result };
            });
            if (
              committed.status === "anchor_unavailable" ||
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
              if (applied === "live_changed") continue;
            }

            const finalized = await input.db.transaction(async (tx) => {
              await lockDocumentMutation(tx, detail.documentId);
              const locked = await loadChange(tx, actionInput, true);
              const state = locked?.change.forwardActions?.[actionInput.action];
              if (!locked || state?.status === "settled") return "anchor_unavailable" as const;
              if (state?.status === "applied") return "already_applied" as const;
              if (state?.status !== "committed" || !sameIntent(state, committed)) {
                return "retry" as const;
              }
              const [journalRow] = await tx
                .insert(documentYjsUpdates)
                .values({
                  documentId: detail.documentId as never,
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
            if (finalized === "anchor_unavailable") return { status: finalized };
            return {
              status:
                alreadyApplied || finalized === "already_applied" ? "already_applied" : "applied",
            };
          }
          return { status: "anchor_unavailable" };
        });
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return { status: "anchor_unavailable" };
        throw cause;
      }
    },
  };
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
  if (input.expectedLiveStateHash !== liveStateFingerprint(input.liveDoc)) {
    return "live_changed";
  }
  // INVARIANT (LOCK-WS): the final full-state recheck and apply are synchronous.
  Y.applyUpdate(input.liveDoc, input.update, input.liveOrigin);
  return "applied";
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
  return createHash("sha256").update(Y.encodeStateAsUpdate(doc)).digest("base64");
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

async function loadChange(
  db: Pick<DrizzleDb, "select">,
  input: { threadId: string; trailId: string; changeId: string },
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
        eq(changeTrailShells.threadId, input.threadId as never),
      ),
    )
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [row] = await query;
  const changes = (row?.changes ?? []) as TrailChangeV1[];
  const change = changes.find((candidate) => candidate.changeId === input.changeId);
  return row && change ? { documentId: row.documentId, changes, change } : null;
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
      if (input.change.navigation.kind !== "deletion_boundary") return null;
      const relative = decodeNavigationPosition(input.change.navigation.position);
      const root = scratch.getXmlFragment("prosemirror");
      const absolute = Y.createAbsolutePositionFromRelativePosition(relative, scratch);
      if (!absolute || absolute.type !== root) return null;
      const previous = absolute.index > 0 ? root.get(absolute.index - 1) : null;
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
