/** Drizzle lifecycle adapter for authoritative upload intake reservations. */

import type { ContextSourceId } from "@meridian/contracts";
import { canonicalContextUri } from "@meridian/contracts/context-uri";
import { type Filetype, firstFreeName, type UploadOwner } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents, projects, threads, uploadIntakes } from "@meridian/database/schema";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { createChatContextDocumentStore } from "../context-source-provisioning.js";
import { createTreeReader, LIVE_TREE } from "../tree/tree-view.js";
import {
  ASSETS_FOLDER,
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

/** An intake's owning chat never changes, so it is safe to read before any lock. A source upload has none. */
async function readIntakeOwner(
  db: Database,
  where: ReturnType<typeof and>,
): Promise<{ projectId: string; chatId: string } | null> {
  const [row] = await currentDrizzleDb(db)
    .select({ projectId: uploadIntakes.projectId, chatId: uploadIntakes.ownerThreadId })
    .from(uploadIntakes)
    .where(where)
    .limit(1);
  return row?.chatId ? { projectId: row.projectId, chatId: row.chatId } : null;
}

/** An upload still on its way: older than this, a crash left it, and its chip stops saying "uploading". */
const IN_FLIGHT_MS = 2 * 60 * 60 * 1000;

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
    documentId: row.documentId,
    fingerprint: row.fingerprint,
    filename: row.filename,
    finalPath: row.finalPath,
    objectKey: row.objectKey,
    // A source upload's address depends on the scope it landed in, which only its caller knows.
    canonicalUri: row.ownerThreadId ? uploadUri(chatRef, row.finalPath) : "",
    locationRevision: row.locationRevision,
    fileType: row.fileType as Filetype,
    state: row.state as UploadReservation["state"],
    storageUrl: row.storageUrl,
    consumed: row.consumedAt !== null,
    owner: row.ownerThreadId
      ? { kind: "chat", chatId: row.ownerThreadId, chatRef }
      : { kind: "source" },
  };
}

const chatRefJoin = (id: typeof uploadIntakes.ownerThreadId) => eq(threads.id, id);

async function projectOwnedBy(db: Database, projectId: string, actorUserId: string) {
  const [project] = await currentDrizzleDb(db)
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId as never),
        eq(projects.userId, actorUserId as never),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  return Boolean(project);
}

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
async function resolveOwner(
  db: Database,
  owner: Extract<UploadOwner, { kind: "chat" }>,
  actorUserId: string,
) {
  const activeDb = currentDrizzleDb(db);
  if (!(await projectOwnedBy(db, owner.projectId, actorUserId))) return null;
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

  /** Runs in `reserve`, which holds the intake's lock. A source upload fixes no name yet: that is `finalize`'s. */
  async function reserveSource(
    projectId: string,
    input: Parameters<UploadIntakeRepository["reserve"]>[0],
  ): Promise<ReserveUploadResult> {
    const activeDb = currentDrizzleDb(db);
    if (!input.documentId || !(await projectOwnedBy(db, projectId, input.actorUserId)))
      return { kind: "owner_unavailable" };
    // The client minted this id; a document already holding it is not this upload's to take.
    const [taken] = await activeDb
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, input.documentId as never))
      .limit(1);
    if (taken) return { kind: "conflict" };
    const [created] = await activeDb
      .insert(uploadIntakes)
      .values({
        projectId: projectId as never,
        intakeId: input.intakeId,
        actorUserId: input.actorUserId as never,
        documentId: input.documentId as never,
        fingerprint: input.fingerprint,
        filename: input.filename,
        mimeType: input.mimeType,
        finalPath: `${ASSETS_FOLDER}/${firstFreeName(input.documentFilename, new Set()).filename}`,
        objectKey: `uploads/${projectId}/${input.documentId}`,
        fileType: input.fileType,
        locationRevision: crypto.randomUUID(),
      })
      .onConflictDoNothing({ target: [uploadIntakes.projectId, uploadIntakes.intakeId] })
      .returning();
    if (!created) {
      const winner = await readReservation(db, projectId, input.intakeId);
      if (!winner) throw new Error("Upload intake winner was not readable");
      return winner.fingerprint === input.fingerprint
        ? { kind: "existing", reservation: winner }
        : { kind: "conflict" };
    }
    return { kind: "reserved", reservation: mapRow(created, null) };
  }

  return {
    transaction: (operation) => runInDrizzleTransaction(db, operation),
    async reserve(input): Promise<ReserveUploadResult> {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        const { owner: requester } = input;
        if (requester.kind === "chat") await lockChat(db, requester.projectId, requester.chatId);
        await lockIntakeKey(db, input.owner.projectId, input.intakeId);
        const existing = await readReservation(db, input.owner.projectId, input.intakeId);
        if (existing) {
          return existing.fingerprint === input.fingerprint
            ? { kind: "existing", reservation: existing }
            : { kind: "conflict" };
        }
        if (requester.kind === "source") return reserveSource(requester.projectId, input);
        const owner = await resolveOwner(db, requester, input.actorUserId);
        if (!owner) return { kind: "owner_unavailable" };
        await activeDb.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${owner.sourceId}, 0))`,
        );
        const [liveNames, reservedNames] = await Promise.all([
          createTreeReader(db).namesAt(LIVE_TREE, {
            contextSourceId: owner.sourceId as ContextSourceId,
            parentId: null,
          }),
          activeDb
            .select({ path: uploadIntakes.finalPath })
            .from(uploadIntakes)
            .where(
              and(
                eq(uploadIntakes.contextSourceId, owner.sourceId),
                sql`${uploadIntakes.state} <> 'deleted'`,
              ),
            ),
        ]);
        const used = new Set([...liveNames, ...reservedNames.map((row) => row.path)]);
        const chatId = requester.chatId;
        const finalPath = firstFreeName(input.documentFilename, used).filename;
        const documentId = crypto.randomUUID();
        const [created] = await activeDb
          .insert(uploadIntakes)
          .values({
            projectId: input.owner.projectId as never,
            intakeId: input.intakeId,
            actorUserId: input.actorUserId as never,
            ownerThreadId: chatId as never,
            contextSourceId: owner.sourceId,
            documentId,
            fingerprint: input.fingerprint,
            filename: input.filename,
            mimeType: input.mimeType,
            finalPath,
            objectKey: `uploads/${input.owner.projectId}/${documentId}`,
            fileType: input.fileType,
            locationRevision: crypto.randomUUID(),
          })
          .onConflictDoNothing({
            target: [uploadIntakes.projectId, uploadIntakes.intakeId],
          })
          .returning();
        if (!created) {
          const winner = await readReservation(db, input.owner.projectId, input.intakeId);
          if (!winner) throw new Error("Upload intake winner was not readable");
          return winner.fingerprint === input.fingerprint
            ? { kind: "existing", reservation: winner }
            : { kind: "conflict" };
        }
        return { kind: "reserved", reservation: mapRow(created, owner.chatRef) };
      });
    },
    async abandon(projectId, intakeId) {
      await runInDrizzleTransaction(db, async () => {
        await lockIntakeKey(db, projectId, intakeId);
        await currentDrizzleDb(db)
          .delete(uploadIntakes)
          .where(
            and(
              eq(uploadIntakes.projectId, projectId as never),
              eq(uploadIntakes.intakeId, intakeId),
              eq(uploadIntakes.state, "reserved"),
            ),
          );
      });
    },
    async markObjectStored(projectId, intakeId, storageUrl) {
      await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ state: "object_stored", storageUrl, updatedAt: new Date() })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
          ),
        );
    },
    async resetObjectStored(projectId, intakeId) {
      await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ state: "reserved", storageUrl: null, updatedAt: new Date() })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
            eq(uploadIntakes.state, "object_stored"),
          ),
        );
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
    async finalize(projectId, intakeId, finalPath) {
      const [row] = await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ state: "finalized", updatedAt: new Date(), ...(finalPath ? { finalPath } : {}) })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
            sql`${uploadIntakes.state} IN ('reserved', 'object_stored', 'finalized')`,
          ),
        )
        .returning();
      if (!row) throw new Error("Upload reservation unavailable during finalize");
      return mapRow(row, row.ownerThreadId ? await chatRefOf(row.ownerThreadId) : null);
    },
    async lockForDelete(input, actorUserId) {
      const identity = and(
        isNotNull(uploadIntakes.ownerThreadId),
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
          objectKey: row.storageUrl ? row.objectKey : undefined,
        };
      }
      if (row.consumedAt) return { kind: "refused", result: { kind: "already_used" } };
      // The address spelling is not identity: a New-chat atom still holds the chat-relative
      // spelling after the chat row (and its handle) exists. The document and revision pin it.
      if (row.documentId !== input.documentId || row.locationRevision !== input.expectedRevision)
        return { kind: "refused", result: { kind: "identity_mismatch" } };
      return {
        kind: "claimed",
        reservation: mapRow(row, row.ownerThreadId ? await chatRefOf(row.ownerThreadId) : null),
      };
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
    async inFlight(projectId, actorUserId, documentIds) {
      if (documentIds.length === 0) return new Set();
      const rows = await currentDrizzleDb(db)
        .select({ documentId: uploadIntakes.documentId })
        .from(uploadIntakes)
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.actorUserId, actorUserId as never),
            inArray(uploadIntakes.documentId, [...documentIds] as never[]),
            inArray(uploadIntakes.state, ["reserved", "object_stored"]),
            gt(uploadIntakes.updatedAt, new Date(Date.now() - IN_FLIGHT_MS)),
          ),
        );
      return new Set<string>(rows.map((row) => row.documentId));
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
  };
}
