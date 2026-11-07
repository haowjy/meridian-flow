/** Drizzle lifecycle adapter for authoritative upload intake reservations. */

import type { ContextSourceId } from "@meridian/contracts";
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { type Filetype, firstFreeName, type UploadOwner } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { projects, threads, uploadIntakes } from "@meridian/database/schema";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { createChatContextDocumentStore } from "../context-source-provisioning.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";
import {
  type ClaimedUpload,
  claimedOf,
  type ReserveUploadResult,
  type UploadIntakeRepository,
  type UploadReservation,
} from "./upload-intake.js";

type IntakeRow = typeof uploadIntakes.$inferSelect;

async function lockIntakeKey(db: Database, projectId: string, intakeId: string): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`upload-intake:${projectId}:${intakeId}`}, 0))`,
  );
}

/** An intake's owning chat never changes, so it is safe to read before any lock. */
async function readIntakeOwner(
  db: Database,
  where: ReturnType<typeof and>,
): Promise<{ projectId: string; chatId: string } | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: uploadIntakes.projectId, chatId: uploadIntakes.ownerThreadId })
    .from(uploadIntakes)
    .where(where)
    .limit(1);
  return row ? { projectId: row.projectId, chatId: row.chatId } : null;
}

/**
 * The chat's row may not exist yet (a New-chat upload), so the chat id is locked as a key, not a
 * row. It comes first, before the intake key and the source (the lock order of file-access §5).
 */
async function lockChat(db: Database, projectId: string, chatId: string): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`upload-chat:${projectId}:${chatId}`}, 0))`,
  );
}

/**
 * An upload's address is derived from its chat's current handle, never frozen: a chat that has no
 * row yet has no handle, so its uploads read as the chat-relative `uploads://name` until it does.
 */
function uploadUri(chatRef: string | null, path: string): string {
  return canonicalContextUri(
    "uploads",
    path,
    chatRef ? { kind: "chat", chatRef } : { kind: "contextual" },
  );
}

function mapRow(row: IntakeRow, chatRef: string | null): UploadReservation {
  return {
    projectId: row.projectId,
    intakeId: row.intakeId,
    actorUserId: row.actorUserId,
    documentId: row.documentId,
    fingerprint: row.fingerprint,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    finalPath: row.finalPath,
    objectKey: row.objectKey,
    canonicalUri: row.finalPath ? uploadUri(chatRef, row.finalPath) : null,
    locationRevision: row.locationRevision,
    fileType: row.fileType as Filetype | null,
    state: row.state as UploadReservation["state"],
    storageUrl: row.storageUrl,
    consumed: row.consumedAt !== null,
    owner: { kind: "chat", chatId: row.ownerThreadId, chatRef },
  };
}

const chatRefJoin = (id: typeof uploadIntakes.ownerThreadId) => eq(threads.id, id);

async function readReservation(db: Database, projectId: string, intakeId: string) {
  const [row] = await currentDrizzleDb(db)
    .select({ intake: uploadIntakes, chatRef: threads.ref })
    .from(uploadIntakes)
    .leftJoin(threads, chatRefJoin(uploadIntakes.ownerThreadId))
    .where(
      and(eq(uploadIntakes.projectId, projectId as never), eq(uploadIntakes.intakeId, intakeId)),
    )
    .limit(1);
  return row ? mapRow(row.intake, row.chatRef) : null;
}

/** Runs in `reserve`, which already holds the owning chat's lock. */
async function resolveOwner(db: Database, owner: UploadOwner, actorUserId: string) {
  const activeDb = currentDrizzleDb(db);
  const [project] = await activeDb
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, owner.projectId as never),
        eq(projects.userId, actorUserId as never),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!project) return null;
  // No row yet is a New-chat upload. A row must be a primary thread of this project: a fork or
  // handoff is its own chat, and a subagent's uploads belong to its top chat, never to itself.
  const [chat] = await activeDb
    .select({ ref: threads.ref, kind: threads.kind, projectId: threads.projectId })
    .from(threads)
    .where(eq(threads.id, owner.chatId as never))
    .limit(1);
  if (chat && (chat.kind !== "primary" || chat.projectId !== owner.projectId)) return null;
  const store = createChatContextDocumentStore(db, owner.projectId, owner.chatId, "uploads");
  const sourceId = await store.contextSourceId();
  return { sourceId, chatRef: chat?.ref ?? null };
}

export function createDrizzleUploadIntakeRepository(db: Database): UploadIntakeRepository {
  async function chatRefOf(chatId: string): Promise<string | null> {
    const [thread] = await currentDrizzleDb(db)
      .select({ ref: threads.ref })
      .from(threads)
      .where(eq(threads.id, chatId as never))
      .limit(1);
    return thread?.ref ?? null;
  }

  return {
    transaction: (operation) => runInDrizzleTransaction(db, operation),
    async reserve(input): Promise<ReserveUploadResult> {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        await lockChat(db, input.owner.projectId, input.owner.chatId);
        await lockIntakeKey(db, input.owner.projectId, input.intakeId);
        const existing = await readReservation(db, input.owner.projectId, input.intakeId);
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) return { kind: "conflict" };
          // A start again is the browser saying it is still uploading: the sweep leaves it be.
          if (existing.state === "reserved" || existing.state === "object_stored")
            await activeDb
              .update(uploadIntakes)
              .set({ updatedAt: new Date() })
              .where(
                and(
                  eq(uploadIntakes.projectId, input.owner.projectId as never),
                  eq(uploadIntakes.intakeId, input.intakeId),
                ),
              );
          return { kind: "existing", reservation: existing };
        }
        const owner = await resolveOwner(db, input.owner, input.actorUserId);
        if (!owner) return { kind: "owner_unavailable" };
        const documentId = crypto.randomUUID();
        const [created] = await activeDb
          .insert(uploadIntakes)
          .values({
            projectId: input.owner.projectId as never,
            intakeId: input.intakeId,
            actorUserId: input.actorUserId as never,
            ownerThreadId: input.owner.chatId as never,
            contextSourceId: owner.sourceId,
            documentId,
            fingerprint: input.fingerprint,
            filename: input.filename,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            objectKey: `uploads/${input.owner.projectId}/${documentId}`,
            locationRevision: crypto.randomUUID(),
          })
          .returning();
        if (!created) throw new Error("Upload intake was not created under its lock");
        return { kind: "reserved", reservation: mapRow(created, owner.chatRef) };
      });
    },
    async readOwned(projectId, intakeId, actorUserId, chatId) {
      const reservation = await readReservation(db, projectId, intakeId);
      return reservation?.actorUserId === actorUserId && reservation.owner.chatId === chatId
        ? reservation
        : null;
    },
    async claim(input) {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        const owner = await readIntakeOwner(
          db,
          and(
            eq(uploadIntakes.projectId, input.projectId as never),
            eq(uploadIntakes.intakeId, input.intakeId),
          ),
        );
        if (!owner) return { kind: "gone" };
        await lockChat(db, owner.projectId, owner.chatId);
        await lockIntakeKey(db, input.projectId, input.intakeId);
        const [row] = await activeDb
          .select()
          .from(uploadIntakes)
          .where(
            and(
              eq(uploadIntakes.projectId, input.projectId as never),
              eq(uploadIntakes.intakeId, input.intakeId),
            ),
          )
          .limit(1);
        if (!row) return { kind: "gone" };
        if (row.state !== "reserved")
          return { kind: "existing", reservation: mapRow(row, await chatRefOf(row.ownerThreadId)) };
        // The name is taken now, after the bytes are read: serialised per source against every
        // other writer of that source's names.
        await activeDb.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${row.contextSourceId}, 0))`,
        );
        const [liveNames, reservedNames] = await Promise.all([
          createTreeReader(db).namesAt(LIVE_TREE, {
            contextSourceId: row.contextSourceId as ContextSourceId,
            parentId: null,
          }),
          activeDb
            .select({ path: uploadIntakes.finalPath })
            .from(uploadIntakes)
            .where(
              and(
                eq(uploadIntakes.contextSourceId, row.contextSourceId),
                sql`${uploadIntakes.state} <> 'deleted'`,
              ),
            ),
        ]);
        const used = new Set([...liveNames, ...reservedNames.flatMap((r) => r.path ?? [])]);
        const [claimed] = await activeDb
          .update(uploadIntakes)
          .set({
            state: "object_stored",
            fileType: input.fileType,
            finalPath: firstFreeName(input.documentFilename, used).filename,
            storageUrl: input.storageUrl,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(uploadIntakes.projectId, input.projectId as never),
              eq(uploadIntakes.intakeId, input.intakeId),
              eq(uploadIntakes.state, "reserved"),
            ),
          )
          .returning();
        if (!claimed) throw new Error("Upload intake changed under its lock");
        return {
          kind: "claimed",
          reservation: mapRow(claimed, await chatRefOf(claimed.ownerThreadId)),
        };
      });
    },
    async lockForFinalize(projectId, intakeId) {
      const owner = await readIntakeOwner(
        db,
        and(eq(uploadIntakes.projectId, projectId as never), eq(uploadIntakes.intakeId, intakeId)),
      );
      if (owner) await lockChat(db, owner.projectId, owner.chatId);
      await lockIntakeKey(db, projectId, intakeId);
      const reservation = await readReservation(db, projectId, intakeId);
      if (!reservation) throw new Error("Upload reservation unavailable during finalize");
      return reservation;
    },
    async finalize(projectId, intakeId, tracked) {
      const [row] = await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({
          state: "finalized",
          updatedAt: new Date(),
          // Tracked text lives in its document: the object it was read from goes with finish.
          ...(tracked ? { storageUrl: null } : {}),
        })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
            sql`${uploadIntakes.state} IN ('reserved', 'object_stored', 'finalized')`,
          ),
        )
        .returning();
      if (!row) throw new Error("Upload reservation unavailable during finalize");
      return claimedOf(mapRow(row, await chatRefOf(row.ownerThreadId)));
    },
    async lockForDelete(input, actorUserId) {
      const identity = and(
        eq(uploadIntakes.intakeId, input.intakeId),
        eq(uploadIntakes.documentId, input.documentId as never),
        sql`exists (
          select 1 from projects
          where projects.id = ${uploadIntakes.projectId}
            and projects.user_id = ${actorUserId}
            and projects.deleted_at is null
        )`,
      );
      const owner = await readIntakeOwner(db, identity);
      if (owner) await lockChat(db, owner.projectId, owner.chatId);
      const [row] = await currentDrizzleDb(db)
        .select()
        .from(uploadIntakes)
        .where(identity)
        .for("update")
        .limit(1);
      if (!row) return { kind: "refused", result: { kind: "identity_mismatch" } };
      if (row.state === "deleted") {
        return {
          kind: "refused",
          result: { kind: "already_deleted" },
          reservation: mapRow(row, null),
        };
      }
      if (row.consumedAt) return { kind: "refused", result: { kind: "already_used" } };
      // The address spelling is not identity: a New-chat atom still holds the chat-relative
      // spelling after the chat row (and its handle) exists. The document and revision pin it.
      if (row.documentId !== input.documentId || row.locationRevision !== input.expectedRevision)
        return { kind: "refused", result: { kind: "identity_mismatch" } };
      return { kind: "claimed", reservation: mapRow(row, await chatRefOf(row.ownerThreadId)) };
    },
    async markDeleted(projectId, intakeId) {
      await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ state: "deleted", updatedAt: new Date() })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
          ),
        );
    },
    async consume(documentIds, chatId) {
      if (documentIds.length === 0) return [];
      const consumed = await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(uploadIntakes.documentId, [...documentIds] as never[]),
            eq(uploadIntakes.ownerThreadId, chatId as never),
            eq(uploadIntakes.state, "finalized"),
            isNull(uploadIntakes.consumedAt),
          ),
        )
        .returning({ contextSourceId: uploadIntakes.contextSourceId });
      return [...new Set(consumed.map((row) => row.contextSourceId as string))];
    },
    async listAbandoned(cutoff, limit) {
      return currentDrizzleDb(db)
        .select({
          projectId: uploadIntakes.projectId,
          intakeId: uploadIntakes.intakeId,
          documentId: uploadIntakes.documentId,
          objectKey: uploadIntakes.objectKey,
        })
        .from(uploadIntakes)
        .where(
          and(
            sql`${uploadIntakes.state} IN ('reserved', 'object_stored')`,
            lt(uploadIntakes.updatedAt, cutoff),
          ),
        )
        .orderBy(uploadIntakes.updatedAt)
        .limit(limit);
    },
    async dropAbandoned(projectId, intakeId, cutoff) {
      const dropped = await currentDrizzleDb(db)
        .delete(uploadIntakes)
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
            sql`${uploadIntakes.state} IN ('reserved', 'object_stored')`,
            lt(uploadIntakes.updatedAt, cutoff),
          ),
        )
        .returning({ intakeId: uploadIntakes.intakeId });
      return dropped.length > 0;
    },
  };
}
