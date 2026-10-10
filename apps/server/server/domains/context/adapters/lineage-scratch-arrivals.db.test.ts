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
  users,
  works,
} from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { createLocalFileAccessChanges } from "../../file-policy/index.js";
import { createWorkProjectionMutation } from "../../projects/adapters/work-projection-mutation.js";
import { createDrizzleProjectWorkRepository } from "../../projects/index.js";
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleDocumentArrivals } from "./document-arrivals.js";
import { createDrizzleLinkAheadRegistry } from "./drizzle-link-ahead-registry.js";
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
    source = crypto.randomUUID();
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
  });
  for (const door of ["chat", "Work"] as const)
    it(`settles only live content through ${door} restore`, async () => {
      const db = database.current;
      const registry = createDrizzleLinkAheadRegistry(db, async () => ({ members: [] }));
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
        projectionMutation: createWorkProjectionMutation({ db, availability, catalog }),
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
        { id: note, contextSourceId: source, name: "note", extension: "md" },
        {
          id: deleted,
          contextSourceId: source,
          name: "deleted",
          extension: "md",
          deletedAt: new Date(),
        },
        { id: hidden, contextSourceId: source, folderId: folder, name: "note", extension: "md" },
      ]);
      if (door === "chat") await threadRepo.setTrashState(root as never, "deleted");
      else await workRepo.softDelete(work as never);
      const ahead = crypto.randomUUID(),
        deletedAhead = crypto.randomUUID(),
        hiddenAhead = crypto.randomUUID();
      await registry.register([
        { aheadId: ahead, holderProjectId: p, address: "scratch://@/c1/note.md" },
        { aheadId: deletedAhead, holderProjectId: p, address: "scratch://@/c1/deleted.md" },
        { aheadId: hiddenAhead, holderProjectId: p, address: "scratch://@/c1/hidden/note.md" },
      ]);
      if (door === "chat") await threadRepo.setTrashState(root as never, "visible");
      else await workRepo.restore(work as never);
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
        .values({ id: replacement, contextSourceId: source, name: "note", extension: "md" });
      await arrivals.settle([replacement as never]);
      expect((await settlements()).get(ahead)).toBe(note);
    });
});
