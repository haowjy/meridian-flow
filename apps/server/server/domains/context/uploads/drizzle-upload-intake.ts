/** Drizzle lifecycle adapter for authoritative upload intake reservations. */
import type { Filetype, UploadOwner } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  projects,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { ContextCatalogMutationPort } from "../ports/context-catalog.js";
import type {
  ReserveUploadResult,
  UploadIntakeRepository,
  UploadReservation,
} from "./upload-intake.js";

type IntakeRow = typeof uploadIntakes.$inferSelect;

function renderName(filename: string): { name: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? { name: filename.slice(0, dot), extension: filename.slice(dot + 1).toLowerCase() }
    : { name: filename, extension: "" };
}

function suffixed(filename: string, suffix: number): string {
  if (suffix === 1) return filename;
  const { name, extension } = renderName(filename);
  return `${name} (${suffix})${extension ? `.${extension}` : ""}`;
}

async function lockIntakeKey(db: Database, projectId: string, intakeId: string): Promise<void> {
  await currentDrizzleDb(db).execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`upload-intake:${projectId}:${intakeId}`}, 0))`,
  );
}

function mapRow(row: IntakeRow, workSlug: string | null): UploadReservation {
  return {
    projectId: row.projectId,
    intakeId: row.intakeId,
    documentId: row.documentId,
    fingerprint: row.fingerprint,
    finalPath: row.finalPath,
    objectKey: row.objectKey,
    canonicalUri: row.canonicalUri,
    locationRevision: row.locationRevision,
    fileType: row.fileType as Filetype,
    state: row.state as UploadReservation["state"],
    storageUrl: row.storageUrl,
    consumed: row.consumedAt !== null,
    owner: row.workId
      ? { kind: "work", workId: row.workId, workSlug: workSlug ?? "" }
      : { kind: "none" },
  };
}

async function readReservation(db: Database, projectId: string, intakeId: string) {
  const [row] = await currentDrizzleDb(db)
    .select({ intake: uploadIntakes, workSlug: works.slug })
    .from(uploadIntakes)
    .leftJoin(works, eq(works.id, uploadIntakes.workId))
    .where(
      and(eq(uploadIntakes.projectId, projectId as never), eq(uploadIntakes.intakeId, intakeId)),
    )
    .limit(1);
  return row ? mapRow(row.intake, row.workSlug) : null;
}

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
  let workSlug: string | null = null;
  if (owner.kind === "work") {
    const locked = await activeDb.execute(sql`
      select slug from works
      where id = ${owner.workId} and project_id = ${owner.projectId}
        and deleted_at is null and status = 'active'
      for update
    `);
    workSlug = (locked[0]?.slug as string | undefined) ?? null;
    if (!workSlug) return null;
  }
  const workId = owner.kind === "work" ? owner.workId : null;
  const scopePredicate = workId
    ? eq(contextSources.workId, workId as never)
    : and(eq(contextSources.projectId, owner.projectId as never), isNull(contextSources.workId));
  const [existing] = await activeDb
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(
      and(scopePredicate, eq(contextSources.slug, "uploads"), isNull(contextSources.deletedAt)),
    )
    .limit(1);
  let sourceId = existing?.id;
  if (!sourceId) {
    const [created] = await activeDb
      .insert(contextSources)
      .values({
        ...(workId
          ? { workId: workId as never, scope: "work" }
          : { projectId: owner.projectId as never, scope: "project" }),
        name: "Uploads",
        slug: "uploads",
        adapterType: "local",
      })
      .onConflictDoNothing()
      .returning({ id: contextSources.id });
    sourceId = created?.id;
    if (!sourceId) {
      const [raced] = await activeDb
        .select({ id: contextSources.id })
        .from(contextSources)
        .where(
          and(scopePredicate, eq(contextSources.slug, "uploads"), isNull(contextSources.deletedAt)),
        )
        .limit(1);
      sourceId = raced?.id;
    }
  }
  return sourceId ? { sourceId, workSlug, workId } : null;
}

export function createDrizzleUploadIntakeRepository(
  db: Database,
  catalog?: ContextCatalogMutationPort,
): UploadIntakeRepository {
  return {
    transaction: (operation) => runInDrizzleTransaction(db, operation),
    async reserve(input): Promise<ReserveUploadResult> {
      return runInDrizzleTransaction(db, async () => {
        const activeDb = currentDrizzleDb(db);
        await lockIntakeKey(db, input.owner.projectId, input.intakeId);
        const existing = await readReservation(db, input.owner.projectId, input.intakeId);
        if (existing) {
          return existing.fingerprint === input.fingerprint
            ? { kind: "existing", reservation: existing }
            : { kind: "conflict" };
        }
        const owner = await resolveOwner(db, input.owner, input.actorUserId);
        if (!owner) return { kind: "owner_unavailable" };
        await activeDb.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${owner.sourceId}, 0))`,
        );
        const [documentNames, reservedNames] = await Promise.all([
          activeDb
            .select({ name: documents.name, extension: documents.extension })
            .from(documents)
            .where(
              and(
                eq(documents.contextSourceId, owner.sourceId),
                isNull(documents.folderId),
                isNull(documents.deletedAt),
              ),
            ),
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
        const used = new Set([
          ...documentNames.map((row) =>
            `${row.name}${row.extension ? `.${row.extension}` : ""}`.toLocaleLowerCase(),
          ),
          ...reservedNames.map((row) => row.path.toLocaleLowerCase()),
        ]);
        let suffix = 1;
        let finalPath = suffixed(input.filename, suffix);
        while (used.has(finalPath.toLocaleLowerCase()))
          finalPath = suffixed(input.filename, ++suffix);
        const documentId = crypto.randomUUID();
        const workAuthority = owner.workSlug ? `@${owner.workSlug}` : "@";
        const canonicalUri = `uploads://${workAuthority}/${finalPath}`;
        const [created] = await activeDb
          .insert(uploadIntakes)
          .values({
            projectId: input.owner.projectId as never,
            intakeId: input.intakeId,
            actorUserId: input.actorUserId as never,
            workId: owner.workId as never,
            contextSourceId: owner.sourceId,
            documentId,
            fingerprint: input.fingerprint,
            byteDigest: input.byteDigest,
            filename: input.filename,
            mimeType: input.mimeType,
            finalPath,
            objectKey: `uploads/${input.owner.projectId}/${documentId}`,
            fileType: input.fileType,
            canonicalUri,
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
        return { kind: "reserved", reservation: mapRow(created, owner.workSlug) };
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
      await lockIntakeKey(db, projectId, intakeId);
      const reservation = await readReservation(db, projectId, intakeId);
      if (!reservation) throw new Error("Upload reservation unavailable during finalize");
      return reservation;
    },
    async finalize(projectId, intakeId) {
      const [row] = await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ state: "finalized", updatedAt: new Date() })
        .where(
          and(
            eq(uploadIntakes.projectId, projectId as never),
            eq(uploadIntakes.intakeId, intakeId),
            sql`${uploadIntakes.state} IN ('reserved', 'object_stored', 'finalized')`,
          ),
        )
        .returning();
      if (!row) throw new Error("Upload reservation unavailable during finalize");
      const workSlug = row.workId
        ? ((
            await currentDrizzleDb(db)
              .select({ slug: works.slug })
              .from(works)
              .where(eq(works.id, row.workId))
              .limit(1)
          )[0]?.slug ?? null)
        : null;
      return mapRow(row, workSlug);
    },
    async deleteDraft(input, actorUserId) {
      return runInDrizzleTransaction(db, async () => {
        const [row] = await currentDrizzleDb(db)
          .select()
          .from(uploadIntakes)
          .where(
            and(
              eq(uploadIntakes.intakeId, input.intakeId),
              eq(uploadIntakes.documentId, input.documentId as never),
              sql`exists (
                select 1 from projects
                where projects.id = ${uploadIntakes.projectId}
                  and projects.user_id = ${actorUserId}
                  and projects.deleted_at is null
              )`,
            ),
          )
          .for("update")
          .limit(1);
        if (!row) return { result: { kind: "identity_mismatch" } };
        if (row.state === "deleted") {
          return {
            result: { kind: "already_deleted" },
            objectKey: row.storageUrl ? row.objectKey : undefined,
          };
        }
        if (row.consumedAt) return { result: { kind: "already_used" } };
        if (
          row.documentId !== input.documentId ||
          row.canonicalUri !== input.uri ||
          row.locationRevision !== input.expectedRevision
        )
          return { result: { kind: "identity_mismatch" } };
        await currentDrizzleDb(db).delete(documents).where(eq(documents.id, row.documentId));
        await catalog?.refreshSources([row.contextSourceId]);
        await currentDrizzleDb(db)
          .update(uploadIntakes)
          .set({ state: "deleted", updatedAt: new Date() })
          .where(
            and(
              eq(uploadIntakes.projectId, row.projectId),
              eq(uploadIntakes.intakeId, row.intakeId),
            ),
          );
        return {
          result: { kind: "deleted" },
          objectKey: row.storageUrl ? row.objectKey : undefined,
        };
      });
    },
    async consume(documentIds) {
      if (documentIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(uploadIntakes)
        .set({ consumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            inArray(uploadIntakes.documentId, [...documentIds] as never[]),
            eq(uploadIntakes.state, "finalized"),
          ),
        );
    },
  };
}
