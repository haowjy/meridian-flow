/** Arrival hooks settle ahead refs once, against the final tree (contract §9.3–9.4, L1–L2). */

import { createHash, randomUUID } from "node:crypto";
import { aheadAddress } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  threads,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { createNoopEventSink } from "../observability/index.js";
import { processDetachedWork } from "../runtime/detached-work.js";
import { createInMemoryObjectStore } from "../storage/index.js";
import { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
import { createDrizzleDocumentArrivals } from "./adapters/document-arrivals.js";
import { createContextUploadContentPort } from "./uploads/context-upload-content.js";
import { createDrizzleUploadIntakeRepository } from "./uploads/drizzle-upload-intake.js";
import { createUploadIntake } from "./uploads/upload-intake.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
describe.skipIf(!enabled || !process.env.DATABASE_URL)("ahead-ref arrivals (postgres)", () => {
  // Registration and uploads commit in their own root transactions: committed-data isolation.
  const db = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 6 });
  const gate = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 2 });
  const probe = createDb(process.env.DATABASE_URL ?? "postgres://unused", { max: 2 });
  afterAll(async () => {
    await deleteDrizzleRows(db, [users]);
    await Promise.all([db.close(), gate.close(), probe.close()]);
  });

  const settlement = async (aheadId: string) => {
    const [row] = await db.select().from(linkAheadRefs).where(eq(linkAheadRefs.aheadId, aheadId));
    return row?.settledDocumentId ?? null;
  };

  it("create, upload, folder move-in and Work restore each settle once against the final tree", async () => {
    await deleteDrizzleRows(db, [users]);
    const userId = randomUUID();
    const projectId = randomUUID();
    const workId = randomUUID();
    await db.insert(users).values(conformanceUserValues(userId, "ahead-arrivals"));
    await db.insert(projects).values({ id: projectId, userId, name: "Arrivals", slug: "arrivals" });
    await db.insert(works).values([
      { projectId, createdByUserId: userId, name: "No Work", isNoWork: true },
      { id: workId, projectId, createdByUserId: userId, name: "Draft", slug: "draft" },
    ]);
    await db.insert(contextSources).values([
      {
        projectId,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
        isPrimary: true,
      },
      { workId, name: "Scratch", slug: "scratch", scope: "work" },
    ]);
    const chatId = randomUUID();
    await db.insert(threads).values({
      id: chatId,
      projectId,
      rootThreadId: chatId,
      createdByUserId: userId,
      ref: "c1",
    });
    const ports = await createProductionAppPorts({
      backgroundTasks: processDetachedWork,
      db,
      eventSink: createNoopEventSink(),
      environment: { FLOW_OPENAI_API_KEY: "sk-test-ahead-arrivals" },
    });
    const app = composeAppServices(ports);
    try {
      const authority = await ports.workAuthorityResolver.byId(projectId, workId);
      if (!authority?.workSlug) throw new Error("Fixture Work missing");
      const port = app.contextPorts.forProject(
        projectId,
        userId,
        new Map([[authority.workSlug, authority]]),
      );
      const register = (address: string) => {
        const aheadId = randomUUID();
        return app.linkAheadRegistry
          .register([{ aheadId, holderProjectId: projectId as never, address }])
          .then(() => aheadId);
      };
      const create = async (uri: string) => {
        const created = await port.createTrackedDocument(uri, "");
        if (!created.ok) throw new Error(JSON.stringify(created.error));
        return created.value.documentId;
      };

      // Tracked create, then delete and recreate at the same path: the second never captures.
      const chapterAddress = aheadAddress("manuscript://ch1.md", "link");
      expect(chapterAddress).toBe("manuscript://ch1");
      const chapter = await register(chapterAddress ?? "");
      expect(await settlement(chapter)).toBeNull();
      const first = await create("manuscript://ch1");
      expect(await settlement(chapter)).toBe(first);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, first));
      const second = await create("manuscript://ch1");
      expect(second).not.toBe(first);
      expect(await settlement(chapter)).toBe(first);

      // A manuscript image: live membership is published after the upload commits.
      const image = await register("manuscript://art/map.png");
      const upload = await port.writeBinary("manuscript://art/map.png", {
        fileType: "image",
        storageUrl: "memory://map.png",
        mimeType: "image/png",
        sizeBytes: 3,
      });
      if (!upload.ok) throw new Error(JSON.stringify(upload.error));
      const [map] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.name, "map"), eq(documents.extension, "png")));
      expect(await settlement(image)).toBe(map?.id);

      // The upload's first arrival keeps its ref when the document moves the moment it is live:
      // membership and settlement publish together, so a move cannot slip in between.
      const [manuscript] = await db
        .select({ id: contextSources.id })
        .from(contextSources)
        .where(and(eq(contextSources.projectId, projectId), eq(contextSources.slug, "manuscript")));
      if (!manuscript) throw new Error("Fixture Manuscript missing");
      const realArrivals = createDrizzleDocumentArrivals(db, app.linkAheadRegistry);
      const raced = await register("manuscript://race.png");
      let published!: () => void;
      const publication = new Promise<void>((resolve) => {
        published = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const racing = new DrizzleContextDocumentStore({
        db,
        contextSourceId: manuscript.id,
        arrivals: {
          lockNamespaces: (ids) => realArrivals.lockNamespaces(ids),
          async settle(ids) {
            published();
            await gate;
            return realArrivals.settle(ids);
          },
        },
      });
      const binary = { fileType: "image", mimeType: "image/png", sizeBytes: 1 } as const;
      const uploading = racing.createBinaryDocument({
        ...binary,
        folderId: null,
        name: "race",
        extension: "png",
        storageUrl: "memory://race.png",
      });
      await publication;
      let moveDone = false;
      const moving = port.move("manuscript://race.png", "manuscript://raced.png").finally(() => {
        moveDone = true;
      });
      // The move either finishes in the gap (the defect) or queues behind the upload.
      await until(async () => moveDone || (await lockWaiters(probe)) > 0);
      release();
      const firstUpload = await uploading;
      expect(await moving).toMatchObject({ ok: true });
      expect(await settlement(raced)).toBe(firstUpload.id);

      // A settlement failure fails the upload: nothing is live that a later occupant could
      // take the ref from.
      const failing = await register("manuscript://failure.png");
      const unavailable = async () => {
        throw new Error("settlement unavailable");
      };
      await expect(
        new DrizzleContextDocumentStore({
          db,
          contextSourceId: manuscript.id,
          arrivals: Object.assign({}, realArrivals, {
            settle: unavailable,
            settleCommitted: unavailable,
          }),
        }).createBinaryDocument({
          ...binary,
          folderId: null,
          name: "failure",
          extension: "png",
          storageUrl: "memory://failure.png",
        }),
      ).rejects.toThrow("settlement unavailable");
      expect(
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.name, "failure"), eq(documents.extension, "png"))),
      ).toEqual([]);
      expect(await settlement(failing)).toBeNull();

      // Deleting a finalized upload keeps the identity it settled; a new upload at the same
      // address never captures the ref.
      const intake = createUploadIntake({
        repository: createDrizzleUploadIntakeRepository(db),
        content: createContextUploadContentPort(app.contextPorts),
        objectStore: createInMemoryObjectStore(),
        eventSink: createNoopEventSink(),
        catalog: { refreshSources: async () => "1" },
      });
      for (const [filename, mimeType] of [
        ["delete-target.toml", "application/toml"],
        ["delete-target.png", "image/png"],
      ] as const) {
        const deletedRef = await register(`uploads://@[c1]/${filename}`);
        const bytes = new TextEncoder().encode(`Upload ${filename}`);
        const uploadOnce = async () => {
          const uploaded = await intake.intake({
            intakeId: randomUUID(),
            actorUserId: userId,
            owner: { kind: "chat", projectId, chatId },
            filename,
            mimeType,
            byteDigest: createHash("sha256").update(bytes).digest("hex"),
            bytes,
          });
          if (!uploaded.ok) throw new Error(uploaded.error.code);
          return uploaded.value;
        };
        const firstUpload = await uploadOnce();
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
        const [arrived] = await db
          .select({ intakeId: uploadIntakes.intakeId })
          .from(uploadIntakes)
          .where(eq(uploadIntakes.documentId, firstUpload.documentId as never));
        expect
          .soft(
            await intake.deleteDraft(
              {
                intakeId: arrived?.intakeId ?? "",
                documentId: firstUpload.documentId,
                uri: firstUpload.uri,
                expectedRevision: firstUpload.locationRevision,
              },
              userId,
            ),
            filename,
          )
          .toEqual({ kind: "deleted" });
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
        const replacement = await uploadOnce();
        expect.soft(replacement.uri, filename).toBe(firstUpload.uri);
        expect.soft(await settlement(deletedRef), filename).toBe(firstUpload.documentId);
      }

      // A personal document moved into the project arrives there: live in the project, and
      // the ref waiting at the destination settles on it.
      const castRef = await register("kb://cast.toml");
      const cast = await create("user://cast.toml");
      expect(await port.move("user://cast.toml", "kb://cast.toml")).toMatchObject({ ok: true });
      expect(await settlement(castRef)).toBe(cast);

      // Folder move-in settles against the moved tree; the ref at the vacated path stays put.
      const moved = await create("manuscript://drafts/ch2.toml");
      const vacated = await register("manuscript://drafts/ch2.toml");
      expect(await settlement(vacated)).toBe(moved);
      const destination = await register("manuscript://part-two/ch2.toml");
      expect(await port.move("manuscript://drafts", "manuscript://part-two")).toMatchObject({
        ok: true,
      });
      expect(await settlement(destination)).toBe(moved);
      expect(await settlement(vacated)).toBe(moved);

      // Work restore: the hidden document reappears at its address and settles the waiting ref.
      const notes = await create("scratch://@draft/notes.toml");
      await ports.workRepo.softDelete(workId as WorkId);
      // Registered while the Work is deleted: it keeps its identity, so the ref registers
      // against it and stays unsettled until the restore makes the address live again.
      const waiting = await register("scratch://@draft/notes.toml");
      expect(await settlement(waiting)).toBeNull();
      await ports.workRepo.restore(workId as WorkId);
      expect(await settlement(waiting)).toBe(notes);
    } finally {
      await app.shutdown();
    }
  });
});

async function namespaceWaiters(db: Database, key: string): Promise<number> {
  const rows = await db.execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting FROM pg_locks l
    WHERE l.locktype = 'advisory' AND NOT l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(${key}, 0::bigint)`);
  return rows[0]?.waiting ?? 0;
}

async function lockWaiters(db: Database): Promise<number> {
  const rows = await db.execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting FROM pg_locks
    WHERE NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  return rows[0]?.waiting ?? 0;
}

async function until(condition: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never held");
}

async function _waitForNamespaceWaiter(db: Database, key: string) {
  await until(async () => (await namespaceWaiters(db, key)) > 0);
}
