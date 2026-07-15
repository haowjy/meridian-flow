/** Journal-first forward Restore/Delete-again actions over retained trail evidence. */

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
import type { TrailChangeV1 } from "../domain/trail-read-kernel.js";
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
          const planned = planTrailForwardAction({
            liveDoc,
            change: detail.change,
            action: actionInput.action,
            model: input.model,
            codec: input.codec,
          });
          if (!planned) return { status: "anchor_unavailable" };

          const persisted = await input.db.transaction(async (tx) => {
            await lockDocumentMutation(tx, detail.documentId);
            const locked = await loadChange(tx, actionInput, true);
            if (!locked) return { status: "anchor_unavailable" as const };
            if (locked.change.forwardActions?.[actionInput.action] !== undefined) {
              return { status: "already_applied" as const };
            }
            const [journalRow] = await tx
              .insert(documentYjsUpdates)
              .values({
                documentId: detail.documentId as never,
                updateData: Buffer.from(planned.update),
                originType: "human",
                actorUserId: actionInput.userId as never,
              })
              .returning({ id: documentYjsUpdates.id });
            if (!journalRow) throw new Error("Failed to persist trail forward action");
            const changes = locked.changes.map((change) =>
              change.changeId === actionInput.changeId
                ? {
                    ...change,
                    forwardActions: {
                      ...change.forwardActions,
                      [actionInput.action]: journalRow.id,
                    },
                  }
                : change,
            );
            await tx
              .update(changeTrailDocumentDetails)
              .set({ changes, updatedAt: new Date() })
              .where(
                and(
                  eq(changeTrailDocumentDetails.trailId, actionInput.trailId),
                  eq(changeTrailDocumentDetails.documentId, detail.documentId as never),
                ),
              );
            return { status: "applied" as const };
          });
          if (persisted.status !== "applied") return persisted;

          // Journal durability precedes this live mutation. Keep the final apply synchronous.
          Y.applyUpdate(liveDoc, planned.update, {
            type: "user",
            userId: actionInput.userId,
            reason: `trail-${actionInput.action}`,
          });
          return persisted;
        });
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return { status: "anchor_unavailable" };
        throw cause;
      }
    },
  };
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
