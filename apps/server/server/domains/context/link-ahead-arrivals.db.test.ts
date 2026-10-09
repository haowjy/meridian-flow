/** Arrival hooks settle ahead refs once, against the final tree (contract §9.3–9.4, L1–L2). */
import { createHash, randomUUID } from "node:crypto";
import { toDocHandle } from "@meridian/agent-edit/integration";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import { createDb, type Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  linkAheadRefs,
  projects,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { composeAppServices, createProductionAppPorts } from "../../lib/compose.js";
import { runInDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import {
  createHarness,
  PROJECT_ID,
  resetDatabase,
  SOURCE_ID,
  THREAD_ID,
  USER_ID,
  WORK_ID,
} from "../collab/test-support/change-trail-postgres-harness.js";
import { createNoopEventSink } from "../observability/index.js";
import { createInMemoryObjectStore } from "../storage/index.js";
import { lockNamespaceKeys } from "./adapters/context-fs/document-locations.js";
import { DrizzleContextDocumentStore } from "./adapters/context-fs/drizzle-store.js";
import { createDrizzleDocumentArrivals } from "./adapters/document-arrivals.js";
import { createDrizzleLinkAheadRegistry } from "./adapters/drizzle-link-ahead-registry.js";
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
    const ports = await createProductionAppPorts({
      db,
      eventSink: createNoopEventSink(),
      environment: { OPENAI_API_KEY: "sk-test-ahead-arrivals" },
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
      const chapter = await register("manuscript://ch1.md");
      expect(await settlement(chapter)).toBeNull();
      const first = await create("manuscript://ch1.md");
      expect(await settlement(chapter)).toBe(first);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, first));
      const second = await create("manuscript://ch1.md");
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
        membershipObserver: {
          async documentCreated(documentId) {
            await ports.documentSync.recordManifestDocumentCreated(documentId as DocumentId, {
              projectId: projectId as never,
            });
            published();
            await gate;
          },
          documentDeleted: () => undefined,
        },
        arrivals: realArrivals,
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
          membershipObserver: {
            documentCreated: (documentId) =>
              ports.documentSync.recordManifestDocumentCreated(documentId as DocumentId, {
                projectId: projectId as never,
              }),
            documentDeleted: () => undefined,
          },
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
      });
      const noWorkId = (await ports.workAuthorityResolver.noWork(projectId as never))?.workId;
      for (const [filename, mimeType] of [
        ["delete-target.md", "text/markdown"],
        ["delete-target.png", "image/png"],
      ] as const) {
        const deletedRef = await register(`uploads://@/${filename}`);
        const bytes = new TextEncoder().encode(`Upload ${filename}`);
        const uploadOnce = async () => {
          const uploaded = await intake.intake({
            intakeId: randomUUID(),
            actorUserId: userId,
            owner: { kind: "work", projectId, workId: noWorkId as string },
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

      // A personal document moved into the project arrives there: live in its manifest, and
      // the ref waiting at the destination settles on it.
      const castRef = await register("kb://cast.md");
      const cast = await create("user://cast.md");
      expect(await port.move("user://cast.md", "kb://cast.md")).toMatchObject({ ok: true });
      const [personal] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.userId, userId), eq(projects.isPersonal, true)));
      const members = async (id: string | undefined) =>
        (await ports.documentSync.resolveManifestMembership({ projectId: id as never })).members;
      expect(await members(projectId)).toContain(cast);
      expect(await members(personal?.id)).not.toContain(cast);
      expect(await settlement(castRef)).toBe(cast);

      // Folder move-in settles against the moved tree; the ref at the vacated path stays put.
      const moved = await create("manuscript://drafts/ch2.md");
      const vacated = await register("manuscript://drafts/ch2.md");
      expect(await settlement(vacated)).toBe(moved);
      const destination = await register("manuscript://part-two/ch2.md");
      expect(await port.move("manuscript://drafts", "manuscript://part-two")).toMatchObject({
        ok: true,
      });
      expect(await settlement(destination)).toBe(moved);
      expect(await settlement(vacated)).toBe(moved);

      // Work restore: the hidden document reappears at its address and settles the waiting ref.
      const notes = await create("scratch://@draft/notes.md");
      await ports.workRepo.softDelete(workId as WorkId);
      // Registered while the Work is deleted: it keeps its identity, so the ref registers
      // against it and stays unsettled until the restore makes the address live again.
      const waiting = await register("scratch://@draft/notes.md");
      expect(await settlement(waiting)).toBeNull();
      await ports.workRepo.restore(workId as WorkId);
      expect(await settlement(waiting)).toBe(notes);
    } finally {
      await app.shutdown();
    }
  });

  it("Apply settles in the completion that publishes membership, Work → namespace → holder", async () => {
    await resetDatabase(db);
    const registryFor = (harness: () => ReturnType<typeof createHarness>) =>
      createDrizzleDocumentArrivals(
        db,
        createDrizzleLinkAheadRegistry(db, (input) =>
          harness().crossWorkProbeFixture().branchStore.resolveManifestMembership(input),
        ),
      );
    let crash = false;
    let warm!: ReturnType<typeof createHarness>;
    warm = createHarness(db, {
      arrivals: registryFor(() => warm),
      afterDurableCommit: async () => {
        if (crash) {
          crash = false;
          throw new Error("crash after the durable push commit");
        }
      },
    });
    const fixture = warm.crossWorkProbeFixture();
    const registry = createDrizzleLinkAheadRegistry(db, (input) =>
      fixture.branchStore.resolveManifestMembership(input),
    );

    /** A document the draft creates: SQL identity and a Work-draft manifest entry only. */
    async function draftCreate(name: string) {
      const documentId = randomUUID() as DocumentId;
      await db.insert(documents).values({
        id: documentId,
        contextSourceId: SOURCE_ID,
        name,
        extension: "md",
        fileType: "markdown",
      });
      await fixture.persistence.lifecycle.ensureDocument(documentId);
      const emptyLive = new Y.Doc({ gc: false });
      const branch = await fixture.branchStore.ensureWorkDraftBranch({
        documentId,
        workId: WORK_ID,
        liveDoc: emptyLive,
      });
      emptyLive.destroy();
      const content = new Y.Doc({ gc: false });
      fixture.model.insertBlocks(
        toDocHandle(content),
        null,
        fixture.markupCodec.parse(`${name} text.`),
      );
      await fixture.branchCoordinator.commitUpdate({
        branchId: branch.branchId,
        updateData: Y.encodeStateAsUpdate(content),
        source: "agent",
        threadId: THREAD_ID,
      });
      content.destroy();
      await fixture.branchStore.recordManifestDocumentCreated(documentId, {
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        threadId: THREAD_ID,
      });
      const aheadId = randomUUID();
      await registry.register([
        { aheadId, holderProjectId: PROJECT_ID as never, address: `manuscript://${name}.md` },
      ]);
      // The SQL row exists, but only the draft's manifest holds it: not an arrival yet.
      expect(await settlement(aheadId)).toBeNull();
      return { documentId, aheadId };
    }
    const apply = async (documentId: DocumentId) => {
      const drafts = await fixture.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      });
      const draft = drafts.find((candidate) => candidate.documentId === documentId);
      if (!draft) throw new Error(`missing draft for ${documentId}`);
      return fixture.collab.draftReview.applyWorkDraft({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
        documentId,
        draftId: draft.draftId,
        userId: USER_ID as never,
      });
    };

    // Single, warm: the completion queues on the namespace key holding the Work lock and no
    // holder lock, then settles in the same transaction that publishes membership.
    const single = await draftCreate("arrival-one");
    const [manifest] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.kind, "manifest"));
    const namespace = {
      projectId: PROJECT_ID,
      userId: USER_ID,
      scheme: "manuscript",
      workId: null,
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const taken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gateTx = runInDrizzleTransaction(gate, async () => {
      await lockNamespaceKeys(gate, [namespace]);
      locked();
      await held;
    });
    try {
      await taken;
      const applying = apply(single.documentId);
      await waitForNamespaceWaiter(db, `context-project:${PROJECT_ID}:none:manuscript`);
      const holderFree = await probe.transaction(async (tx) => {
        const [row] = await tx.execute<{ free: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`document-mutation:${manifest?.id}`}, 0::bigint)) AS free`,
        );
        return row?.free;
      });
      const work = await probe
        .transaction((tx) =>
          tx.execute(sql`SELECT id FROM works WHERE id = ${WORK_ID} FOR NO KEY UPDATE NOWAIT`),
        )
        .then(
          () => "free",
          () => "locked",
        );
      const order = { holderFree, work };
      expect(order).toEqual({ holderFree: true, work: "locked" });
      expect(await settlement(single.aheadId)).toBeNull();
      release();
      await expect(applying).resolves.toMatchObject({ status: "applied" });
      expect(await settlement(single.aheadId)).toBe(single.documentId);
    } finally {
      release();
      await gateTx;
    }

    // Batch: switching the Work to auto-apply pushes every pending draft.
    const batch = [await draftCreate("arrival-two"), await draftCreate("arrival-three")];
    await expect(
      fixture.realBranchPush.setWorkPushPolicy({
        workId: WORK_ID as WorkId,
        policy: "auto",
        pending: "apply",
      }),
    ).resolves.toMatchObject({ status: "updated" });
    for (const arrival of batch) {
      expect(await settlement(arrival.aheadId)).toBe(arrival.documentId);
    }
    await db.update(works).set({ aiWriteMode: "draft" }).where(eq(works.id, WORK_ID));

    // Recovered: a crash after the durable commit leaves membership and settlement unpublished
    // together; recovery runs the same completion and publishes both.
    const recovered = await draftCreate("arrival-four");
    crash = true;
    await expect(apply(recovered.documentId)).rejects.toThrow("crash after the durable push");
    expect(await settlement(recovered.aheadId)).toBeNull();
    await db.execute(
      sql`UPDATE branch_push_settlement_outbox SET lease_expires_at = to_timestamp(0), available_at = to_timestamp(0) WHERE state = 'pending'`,
    );
    let cold!: ReturnType<typeof createHarness>;
    cold = createHarness(db, { arrivals: registryFor(() => cold) });
    expect(await cold.recoverPendingLiveSettlements()).toBeGreaterThan(0);
    expect(await settlement(recovered.aheadId)).toBe(recovered.documentId);
    warm.destroyWarmState();
    cold.destroyWarmState();
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

async function waitForNamespaceWaiter(db: Database, key: string) {
  await until(async () => (await namespaceWaiters(db, key)) > 0);
}
