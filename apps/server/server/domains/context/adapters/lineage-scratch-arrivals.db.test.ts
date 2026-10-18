/** Restoring chat and Work visibility claims returning lineage addresses once. */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documents,
  folders,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createDrizzleWorkDraftPendingStore } from "../../collab/adapters/drizzle-branch-push.js";
import { createTestLinkAheadRegistry } from "../../collab/test-support/document-link-scopes.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createWorkProjectionMutation } from "../../projects/adapters/work-projection-mutation.js";
import { createDrizzleProjectWorkRepository } from "../../projects/index.js";
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleDocumentArrivals } from "./document-arrivals.js";
import { createDrizzleLineageScratchLifecycle } from "./lineage-scratch-lifecycle.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const enabled = !!process.env.DATABASE_URL && process.env.RUN_DB_TESTS === "1";
describe.skipIf(!enabled)("lineage restore arrivals", () => {
  const database = useRollbackTestDatabase(process.env.DATABASE_URL ?? "", {
    prepareSuite: (db) => deleteDrizzleRows(db, [users]),
  });
  const u = crypto.randomUUID(),
    p = crypto.randomUUID(),
    root = crypto.randomUUID(),
    work = crypto.randomUUID(),
    source = crypto.randomUUID(),
    uploadsSource = crypto.randomUUID(),
    upload = crypto.randomUUID();
  beforeEach(async () => {
    const db = database.current;
    await db.insert(users).values(conformanceUserValues(u, "lineage-arrivals"));
    await db.insert(projects).values({ id: p, userId: u, name: "Project", slug: "project" });
    await db
      .insert(works)
      .values({ id: work, projectId: p, createdByUserId: u, name: "A", slug: "a" });
    await db
      .insert(threads)
      .values({ id: root, projectId: p, rootThreadId: root, createdByUserId: u, ref: "c1" });
    await db
      .insert(threadWorks)
      .values({ threadId: root, workId: work, projectId: p, isPrimary: true });
    await db.insert(contextSources).values({
      id: source,
      projectId: p,
      rootThreadId: root,
      scope: "lineage",
      name: "Scratch",
      slug: "scratch",
    });
    await db.insert(contextSources).values({
      id: uploadsSource,
      projectId: p,
      chatThreadId: root,
      scope: "chat",
      name: "Uploads",
      slug: "uploads",
    });
    await db
      .insert(documents)
      .values({ id: upload, contextSourceId: uploadsSource, name: "pic", extension: "png" });
    await db.insert(uploadIntakes).values({
      projectId: p,
      intakeId: "intake",
      actorUserId: u,
      ownerThreadId: root,
      contextSourceId: uploadsSource,
      documentId: upload,
      fingerprint: "f",
      byteDigest: "0".repeat(64),
      filename: "pic.png",
      mimeType: "image/png",
      finalPath: "pic.png",
      objectKey: "k",
      fileType: "image",
      canonicalUri: "uploads://pic.png",
      locationRevision: crypto.randomUUID(),
      state: "finalized",
      consumedAt: new Date("2026-01-02T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    } as never);
  });
  for (const door of ["chat", "Work"] as const)
    it(`settles only live content through ${door} restore`, async () => {
      const db = database.current;
      const registry = createTestLinkAheadRegistry(db);
      const arrivals = createDrizzleDocumentArrivals(db, registry);
      const lifecycle = createDrizzleLineageScratchLifecycle(db, undefined, arrivals);
      const threadRepo = createDrizzleThreadRepository(db, { lineageScratch: lifecycle });
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        availabilityMutations: availability,
      });
      const workRepo = createDrizzleProjectWorkRepository({
        db,
        lineageScratch: lifecycle,
        arrivals,
        projectionMutation: createWorkProjectionMutation({
          db,
          pendingCounts: createDrizzleWorkDraftPendingStore(db),
          availability,
          catalog,
        }),
        fileAccessChanges: createLocalFileAccessChanges(),
      });
      const note = crypto.randomUUID(),
        deleted = crypto.randomUUID(),
        hidden = crypto.randomUUID(),
        folder = crypto.randomUUID();
      await db
        .insert(folders)
        .values({ id: folder, contextSourceId: source, name: "hidden", deletedAt: new Date() });
      await db.insert(documents).values([
        { id: note, contextSourceId: source, name: "note", extension: "toml" },
        {
          id: deleted,
          contextSourceId: source,
          name: "deleted",
          extension: "toml",
          deletedAt: new Date(),
        },
        { id: hidden, contextSourceId: source, folderId: folder, name: "note", extension: "toml" },
      ]);
      if (door === "chat") {
        await db
          .update(works)
          .set({ isNoWork: true, name: "No Work", slug: null })
          .where(eq(works.id, work));
        await threadRepo.setTrashState(root as never, "deleted");
      } else await workRepo.softDelete(work as never);
      const lookup = (id = note) =>
        availability.lookup({ projectId: p as never, documentIds: [id] as never }, { userId: u });
      // A hidden lineage is restorable authority, never a terminal document fact.
      await expect(lookup()).resolves.toMatchObject({
        resolutions: [{ kind: "authority-unavailable", reason: "lineage_hidden" }],
      });
      // A trashed chat hides its own uploads the same way, through either door.
      await expect(lookup(upload)).resolves.toMatchObject({
        resolutions: [{ kind: "authority-unavailable", reason: "chat_hidden" }],
      });
      await expect(
        availability.lookup(
          { projectId: p as never, documentIds: [deleted] as never },
          { userId: u },
        ),
      ).resolves.toMatchObject({ resolutions: [{ kind: "deleted" }] });
      const ahead = crypto.randomUUID(),
        deletedAhead = crypto.randomUUID(),
        hiddenAhead = crypto.randomUUID();
      await registry.register([
        { aheadId: ahead, holderProjectId: p, address: "scratch://@/c1/note.toml" },
        { aheadId: deletedAhead, holderProjectId: p, address: "scratch://@/c1/deleted.toml" },
        { aheadId: hiddenAhead, holderProjectId: p, address: "scratch://@/c1/hidden/note.toml" },
      ]);
      if (door === "chat") await threadRepo.setTrashState(root as never, "visible");
      else await workRepo.restore(work as never);
      await expect(lookup()).resolves.toMatchObject({
        resolutions: [{ kind: "available", entry: { entryId: note } }],
      });
      await expect(lookup(upload)).resolves.toMatchObject({
        resolutions: [{ kind: "available", entry: { uri: "uploads://@/c1/pic.png" } }],
      });
      await expect(
        catalog.snapshot({ kind: "chat", projectId: p, chatId: root } as never),
      ).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({
            entryId: upload,
            upload: expect.objectContaining({ attachedAt: "2026-01-01T00:00:00.000Z", used: true }),
          }),
        ]),
      });
      await expect(
        catalog.snapshot({ kind: "lineage", projectId: p, rootThreadId: root } as never),
      ).resolves.toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ entryId: note })]),
      });
      const settlements = async () =>
        new Map(
          (await db.select().from(linkAheadRefs)).map((r) => [r.aheadId, r.settledDocumentId]),
        );
      expect((await settlements()).get(ahead)).toBe(note);
      expect((await settlements()).get(deletedAhead)).toBeNull();
      expect((await settlements()).get(hiddenAhead)).toBeNull();
      await db.update(documents).set({ name: "moved" }).where(eq(documents.id, note));
      const replacement = crypto.randomUUID();
      await db
        .insert(documents)
        .values({ id: replacement, contextSourceId: source, name: "note", extension: "toml" });
      await arrivals.settle([replacement as never]);
      expect((await settlements()).get(ahead)).toBe(note);
    });
});
