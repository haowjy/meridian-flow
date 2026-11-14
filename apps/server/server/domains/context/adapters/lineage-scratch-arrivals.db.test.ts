/** Restoring chat and Work visibility claims returning lineage addresses once. */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  linkAheadRefs,
  projects,
  threads,
  threadWorks,
  uploadIntakes,
  users,
  works,
} from "@meridian/database/schema";
import { LIVE } from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { NO_PROJECT_HINTS } from "../../../test-support/project-hints.js";
import { treeListOfSource, treeSeeder } from "../../../test-support/tree-seed.js";
import { createDrizzleWorkBranchPendingStore } from "../../collab/adapters/drizzle-work-branch-pending.js";
import { createTestLinkAheadRegistry } from "../../collab/test-support/document-link-scopes.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createWorkProjectionMutation } from "../../projects/adapters/work-projection-mutation.js";
import { createDrizzleProjectWorkRepository } from "../../projects/index.js";
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleChatUploads } from "../uploads/index.js";
import { createDrizzleContextSources } from "./context-sources.js";
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
      .values({ id: work, projectId: p, createdByUserId: u, name: "A", handle: "w1" });
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
    await treeSeeder(db).document(uploadsSource, "pic.png", { id: upload });
    await db.insert(uploadIntakes).values({
      projectId: p,
      intakeId: "intake",
      actorUserId: u,
      ownerThreadId: root,
      contextSourceId: uploadsSource,
      documentId: upload,
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: 1,
      finalPath: "pic.png",
      objectKey: "k",
      fileType: "image",
      canonicalUri: "uploads://pic.png",
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
      const sources = createDrizzleContextSources(db);
      const fileAccessChanges = createLocalFileAccessChanges();
      const lifecycle = createDrizzleLineageScratchLifecycle(db, arrivals, {
        fileAccessChanges,
        hints: NO_PROJECT_HINTS,
      });
      const threadRepo = createDrizzleThreadRepository(db, { lineageScratch: lifecycle });
      const availability = createDrizzleProjectContextAvailability(db);
      const workRepo = createDrizzleProjectWorkRepository({
        db,
        lineageScratch: lifecycle,
        arrivals,
        projectionMutation: createWorkProjectionMutation({
          db,
          pendingCounts: createDrizzleWorkBranchPendingStore(db),
          draftOwnerHints: NO_PROJECT_HINTS,
        }),
        fileAccessChanges,
      });
      const note = crypto.randomUUID(),
        deleted = crypto.randomUUID(),
        hidden = crypto.randomUUID();
      const seed = treeSeeder(db);
      const list = await treeListOfSource(db, source);
      const trash = (...ids: string[]) =>
        seed.store.submit({
          lists: [list],
          make: ([{ writer }]) => {
            for (const id of ids) writer.delete(LIVE, "system", id);
          },
        });
      const folder = await seed.folder(source, "hidden");
      await seed.document(source, "note.toml", { id: note });
      await seed.document(source, "deleted.toml", { id: deleted });
      await seed.document(source, "hidden/note.toml", { id: hidden });
      await trash(deleted, folder);
      if (door === "chat") {
        await db
          .update(works)
          .set({ isNoWork: true, name: "No Work", handle: null })
          .where(eq(works.id, work));
        await threadRepo.setTrashState(root as never, "deleted");
      } else await workRepo.softDelete(work as never);
      const placed = async (id = note) =>
        (
          await availability.placed({ projectId: p as never, documentIds: [id] }, { userId: u })
        ).documents.get(id);
      // A hidden lineage or chat is restorable authority: its documents are not placed meanwhile.
      await expect(placed()).resolves.toBeUndefined();
      await expect(placed(upload)).resolves.toBeUndefined();
      await expect(placed(deleted)).resolves.toBeUndefined();
      const ahead = crypto.randomUUID(),
        deletedAhead = crypto.randomUUID(),
        hiddenAhead = crypto.randomUUID();
      await registry.register([
        { aheadId: ahead, holderProjectId: p, address: "scratch://@c1/note.toml" },
        { aheadId: deletedAhead, holderProjectId: p, address: "scratch://@c1/deleted.toml" },
        { aheadId: hiddenAhead, holderProjectId: p, address: "scratch://@c1/hidden/note.toml" },
      ]);
      if (door === "chat") await threadRepo.setTrashState(root as never, "visible");
      else await workRepo.restore(work as never);
      await expect(placed()).resolves.toMatchObject({ entry: { entryId: note } });
      await expect(placed(upload)).resolves.toMatchObject({
        entry: { uri: "uploads://@c1/pic.png" },
      });
      const [uploads] = await sources.ownedBy(p as never, { kind: "chat", chatId: root });
      expect((await sources.liveDocuments(uploads?.id as never)).map((file) => file.id)).toContain(
        upload,
      );
      await expect(createDrizzleChatUploads(db).list(p, root)).resolves.toEqual({
        uploads: [{ documentId: upload, attachedAt: "2026-01-01T00:00:00.000Z", used: true }],
      });
      const [scratch] = await sources.ownedBy(p as never, { kind: "lineage", rootThreadId: root });
      expect((await sources.liveDocuments(scratch?.id as never)).map((file) => file.id)).toContain(
        note,
      );
      const settlements = async () =>
        new Map(
          (await db.select().from(linkAheadRefs)).map((r) => [r.aheadId, r.settledDocumentId]),
        );
      expect((await settlements()).get(ahead)).toBe(note);
      expect((await settlements()).get(deletedAhead)).toBeNull();
      expect((await settlements()).get(hiddenAhead)).toBeNull();
      await seed.store.submit({
        lists: [list],
        make: ([{ writer }]) => {
          writer.rename(LIVE, "system", note, "moved.toml");
        },
      });
      const replacement = crypto.randomUUID();
      await seed.document(source, "note.toml", { id: replacement });
      await arrivals.settle([replacement as never]);
      expect((await settlements()).get(ahead)).toBe(note);
    });
});
