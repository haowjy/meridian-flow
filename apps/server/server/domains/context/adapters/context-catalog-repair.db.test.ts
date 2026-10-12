/** Committed bursts must coalesce before taking Postgres locks and publish the newest state. */
import { createDb } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextAvailabilityHeads,
  contextCatalogEntries,
  contextSources,
  documents,
  folders,
  projects,
  users,
} from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
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
        .values({ id: documentId, contextSourceId: sourceId, name: "chapter", extension: "" });
    });
    afterAll(async () => {
      await processDetachedWork.drain();
      await db.close();
    });

    it.each([
      "file",
      "folder",
    ] as const)("publishes newer provenance when a %s returns to its previous name before repair", async (kind) => {
      const table = kind === "file" ? documents : folders;
      const entryId = kind === "file" ? documentId : "00000000-0000-4000-8000-000000000905";
      if (kind === "folder") {
        await db
          .insert(folders)
          .values({ id: entryId, contextSourceId: sourceId, name: "chapter" });
      }
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delayCalls = 0;
      const catalog = createDrizzleContextCatalog(db, undefined, {
        delay: async () => {
          if (++delayCalls === 1) {
            entered();
            await blocked;
          }
        },
        manifestMembership: {
          async resolveManifestMembership() {
            return { documentId: documentId as never, members: [documentId] };
          },
        },
      });
      const availability = createDrizzleProjectContextAvailability(db);
      await catalog.refreshProject(projectId);
      const initial = await catalog.snapshot(scope);
      const initialEntry = initial.entries.find((entry) => entry.entryId === entryId);
      async function rename(name: string) {
        return runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db).update(table).set({ name }).where(eq(table.id, entryId));
          return catalog.refreshSources([sourceId], [entryId]);
        });
      }
      await rename("Middle");
      await started;
      let middle: Awaited<ReturnType<typeof availability.lookup>> | undefined;
      let latestGeneration = "";
      try {
        middle = await availability.lookup(
          {
            projectId,
            documentIds: kind === "file" ? [documentId as never] : [],
            folderIds: kind === "folder" ? [entryId as never] : [],
          },
          { userId },
        );
        latestGeneration = await rename("chapter");
      } finally {
        release();
        await processDetachedWork.drain();
      }
      const intermediate =
        kind === "file" ? middle?.resolutions[0] : middle?.folderResolutions?.[0];
      if (intermediate?.kind !== "available") throw new Error("Expected exact-ID evidence");
      const final = await catalog.snapshot(scope);
      const finalEntry = final.entries.find((entry) => entry.entryId === entryId);
      const [persisted] = await db
        .select()
        .from(contextCatalogEntries)
        .where(eq(contextCatalogEntries.entryId, entryId));
      expect(persisted.entry).toEqual(finalEntry);
      const changes = await catalog.changes(scope, initial.cursor);
      if (changes.kind !== "delta") throw new Error("Expected retained repair commits");
      const published = changes.commits
        .flatMap((commit) => commit.changes)
        .filter((change) => change.operation === "upsert" && change.entry.entryId === entryId);
      expect(published).toContainEqual(expect.objectContaining({ entry: finalEntry }));
      if (
        (finalEntry?.kind !== "file" && finalEntry?.kind !== "folder") ||
        (initialEntry?.kind !== "file" && initialEntry?.kind !== "folder")
      ) {
        throw new Error("Expected namespace entries");
      }
      expect(BigInt(finalEntry.observationVersion)).toBeGreaterThan(
        BigInt(intermediate.entry.observationVersion),
      );
      expect(BigInt(intermediate.entry.observationVersion)).toBeGreaterThan(
        BigInt(initialEntry.observationVersion),
      );
      const [head] = await db
        .select()
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`));
      expect(String(head.generation)).toBe(latestGeneration);
      // A subsequent no-op refresh deduplicates equal evidence, not newer observations.
      await catalog.refreshProject(projectId);
      expect((await catalog.snapshot(scope)).cursor).toBe(final.cursor);
    });

    it("serializes burst repairs and retries stale observation cuts, preserving invalidations", async () => {
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
      const catalog = createDrizzleContextCatalog(db, undefined, {
        delay,
        manifestMembership: {
          async resolveManifestMembership() {
            active++;
            maximum = Math.max(maximum, active);
            if (hold) {
              entered();
              await blocked;
            }
            active--;
            return { documentId: documentId as never, members: [documentId] };
          },
        },
      });
      const before = await catalog.snapshot(scope);
      hold = true;
      async function rename(name: string, roots: string[] = []) {
        return runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db)
            .update(documents)
            .set({ name })
            .where(eq(documents.id, documentId));
          return catalog.refreshSources([sourceId], roots);
        });
      }
      await rename("first");
      await started;
      let generation = "";
      try {
        for (let i = 0; i < 20; i++) generation = await rename(`newest-${i}`, [`root-${i}`]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(delay).toHaveBeenCalledTimes(1);
      } finally {
        hold = false;
        release();
        await processDetachedWork.drain();
      }
      expect(maximum).toBe(1);
      // Read persisted rows directly: snapshot() itself can repair a stale catalog.
      const entries = await db.select().from(contextCatalogEntries);
      expect(entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({ kind: "file", name: "newest-19" }),
        }),
      );
      const heads = await db
        .select()
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`));
      expect(String(heads[0]?.generation)).toBe(generation);
      const changes = await catalog.changes(scope, before.cursor);
      expect(changes.kind).toBe("delta");
      if (changes.kind !== "delta") throw new Error("Expected retained repair commits");
      const roots = changes.commits
        .flatMap((commit) => commit.changes)
        .filter((change) => change.operation === "invalidate-subtree")
        .map((change) => change.rootEntryId);
      expect(roots.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `root-${i}`).sort());
    });

    it("coalesces post-draft refreshes with source repairs and publishes the newest generation", async () => {
      let release!: () => void;
      let entered!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let hold = false;
      const delay = vi.fn(async () => {});
      const catalog = createDrizzleContextCatalog(db, undefined, {
        delay,
        manifestMembership: {
          async resolveManifestMembership() {
            if (hold) {
              entered();
              await blocked;
            }
            return { documentId: documentId as never, members: [documentId] };
          },
        },
      });
      await catalog.snapshot(scope);
      hold = true;
      await runInDrizzleTransaction(db, () => catalog.refreshSources([sourceId]));
      await started;
      let draftRefreshes: Promise<void> | undefined;
      let sourceGeneration = "";
      try {
        sourceGeneration = await runInDrizzleTransaction(db, async () => {
          await currentDrizzleDb(db)
            .update(documents)
            .set({ name: "after-apply" })
            .where(eq(documents.id, documentId));
          return catalog.refreshSources([sourceId], ["moved-root"]);
        });
        draftRefreshes = Promise.all([
          catalog.refreshProjectDocuments(projectId),
          catalog.refreshProjectDocuments(projectId),
        ]).then(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(delay).toHaveBeenCalledTimes(1);
      } finally {
        hold = false;
        release();
        await draftRefreshes;
        await processDetachedWork.drain();
      }
      const entries = await db.select().from(contextCatalogEntries);
      expect(entries).toContainEqual(
        expect.objectContaining({
          entry: expect.objectContaining({ kind: "file", name: "after-apply" }),
        }),
      );
      const [head] = await db
        .select()
        .from(contextAvailabilityHeads)
        .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`));
      expect(head.generation).toBeGreaterThan(BigInt(sourceGeneration));
    });

    it.each([
      "source",
      "draft",
    ] as const)("logs exhausted %s repair lock timeouts at warn, not error", async (entrypoint) => {
      const eventSink = createInMemoryEventSink();
      const catalog = createDrizzleContextCatalog(db, undefined, {
        eventSink,
        delay: async () => {},
        manifestMembership: {
          async resolveManifestMembership() {
            return { documentId: documentId as never, members: [documentId] };
          },
        },
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
        if (entrypoint === "source") {
          await runInDrizzleTransaction(db, () => catalog.refreshSources([sourceId]));
          await processDetachedWork.drain();
        } else {
          await expect(catalog.refreshProjectDocuments(projectId)).resolves.toBeUndefined();
        }
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
