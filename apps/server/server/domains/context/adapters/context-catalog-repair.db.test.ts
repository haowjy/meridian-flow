/** Committed bursts must coalesce before taking Postgres locks and publish the newest state. */
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextCatalogEntries,
  contextSources,
  documents,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createInMemoryEventSink } from "../../observability/index.js";
import { processDetachedWork } from "../../runtime/detached-work.js";
import { createDrizzleContextCatalog } from "./context-catalog.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const url = process.env.DATABASE_URL;
if (!enabled || !url) {
  describe.skip("catalog repair bursts (postgres)", () => {});
} else {
  describe("catalog repair bursts (postgres)", () => {
    const db = createDb(url);
    const userId = "00000000-0000-4000-8000-000000000901";
    const projectId = "00000000-0000-4000-8000-000000000902";
    const sourceId = "00000000-0000-4000-8000-000000000903";
    const documentId = "00000000-0000-4000-8000-000000000904";
    const scope = { kind: "project", projectId } as const;
    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
      await db.insert(users).values(conformanceUserValues(userId, "catalog-burst"));
      await db.insert(projects).values({ id: projectId, userId, name: "Burst", slug: "burst" });
      await db
        .insert(contextSources)
        .values({ id: sourceId, projectId, name: "Manuscript", slug: "manuscript" });
      await db
        .insert(documents)
        .values({ id: documentId, contextSourceId: sourceId, name: "chapter", extension: "md" });
    });
    afterAll(async () => {
      await processDetachedWork.drain();
      await db.close();
    });

    // A source refresh is synchronous now (the catalog reads the live tree); the queue
    // still coalesces post-Apply project refreshes.
    it("runs one repair plus one dirty rerun for a committed burst of project refreshes", async () => {
      let hold = false;
      let release: () => void = () => {};
      let entered: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let active = 0;
      let maximum = 0;
      const delay = vi.fn(async () => {});
      const availability = createDrizzleProjectContextAvailability(db);
      const catalog = createDrizzleContextCatalog(db, undefined, {
        delay,
        availabilityMutations: {
          ...availability,
          async reserve() {
            active++;
            maximum = Math.max(maximum, active);
            if (hold) {
              entered();
              await blocked;
            }
            active--;
            return availability.reserve();
          },
        },
      });
      await catalog.snapshot(scope);
      hold = true;
      async function rename(name: string) {
        await db.update(documents).set({ name }).where(eq(documents.id, documentId));
        return catalog.refreshProjectDocuments(projectId);
      }
      const refreshes = [rename("first")];
      await started;
      try {
        for (let i = 0; i < 20; i++) refreshes.push(rename(`newest-${i}`));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(delay).toHaveBeenCalledTimes(1);
      } finally {
        hold = false;
        release();
        await Promise.all(refreshes);
        await processDetachedWork.drain();
      }
      expect(maximum).toBe(1);
      expect(delay).toHaveBeenCalledTimes(2);
      // Read persisted rows directly: snapshot() itself can repair a stale catalog.
      const entries = await db.select().from(contextCatalogEntries);
      expect(entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({ kind: "file", name: "newest-19.md" }),
        }),
      );
    });

    it("logs exhausted project repair lock timeouts at warn, not error", async () => {
      const eventSink = createInMemoryEventSink();
      const catalog = createDrizzleContextCatalog(db, undefined, {
        eventSink,
        delay: async () => {},
      });
      await catalog.snapshot(scope);
      const lockDb = createDb(url, { max: 1 });
      let release: () => void = () => {};
      let acquired: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const lock = lockDb.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from context_catalog_scope_heads where scope_key = ${`project:${projectId}`} for update`,
        );
        acquired();
        await held;
      });
      await ready;
      try {
        await expect(catalog.refreshProjectDocuments(projectId)).resolves.toBeUndefined();
        expect(eventSink.events).toContainEqual(
          expect.objectContaining({ name: "DeferredRefreshFailure", level: "warn" }),
        );
        expect(eventSink.events.filter((event) => event.level === "error")).toEqual([]);
      } finally {
        release();
        await lock;
        await lockDb.close();
      }
    });
  });
}
