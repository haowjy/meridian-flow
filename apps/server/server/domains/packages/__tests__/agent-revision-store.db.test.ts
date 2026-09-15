/** Postgres contracts for retained Agent identity, catalog ownership, and transactional binding. */
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { truncateDrizzleTables } from "../../../test-support/drizzle-reset.js";
import { createDrizzleAgentRevisionStore } from "../adapters/drizzle-agent-revision-store.js";

const USER = "00000000-0000-4000-8000-000000000871";
const OTHER = "00000000-0000-4000-8000-000000000872";
const PROJECT = "00000000-0000-4000-8000-000000000873";
const THREAD = "00000000-0000-4000-8000-000000000874";
const url = process.env.DATABASE_URL;
const source = (body = "Original prompt.") => ({
  coordinate: "fixture/agents",
  files: {
    "agents/general.md": `---\nname: General\nmodel: fixture-model\n---\n\n${body}`,
    "skills/voice/SKILL.md": "---\nname: voice\n---\n\nVoice guidance.",
    "skills/voice/reference.bin": { encoding: "base64" as const, data: "AP8=" },
  },
});

if (!url || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  describe.skip("Agent revision store (postgres)", () => {});
} else {
  assertThrowawayDatabaseForRunDbTests(url);
  describe("Agent revision store (postgres)", () => {
    const db = createDb(url, { max: 4 });
    const store = createDrizzleAgentRevisionStore(db);
    beforeEach(async () => {
      await truncateDrizzleTables(db, [schema.users, schema.agentPackageRevisions]);
      await db
        .insert(schema.users)
        .values([
          conformanceUserValues(USER, "agent-owner"),
          conformanceUserValues(OTHER, "agent-other"),
        ]);
      await db
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Agents", slug: "agents" });
      await db
        .insert(schema.threads)
        .values({ id: THREAD, projectId: PROJECT, createdByUserId: USER, slug: "agent-test" });
    });
    afterAll(() => db.close());

    it("retains exact source bytes and definitions across independent connections", async () => {
      const original = source();
      const installed = await store.installSource(original);
      const reopenedDb = createDb(url, { max: 1 });
      try {
        const reopened = createDrizzleAgentRevisionStore(reopenedDb);
        expect(await reopened.readSource(installed.packageRevisionId)).toEqual(original);
        expect(await reopened.readRevision(installed.definitions[0].id)).toEqual(
          installed.definitions[0],
        );
        expect(await reopened.installSource(original)).toEqual(installed);
      } finally {
        await reopenedDb.close();
      }
    });

    it("deduplicates concurrent installs and creates one logical catalog entry", async () => {
      const installs = await Promise.all([
        store.installSource(source()),
        store.installSource(source()),
      ]);
      expect(installs[0]).toEqual(installs[1]);
      const select = {
        ownerUserId: USER,
        logicalKey: "general",
        revisionId: installs[0].definitions[0].id,
      };
      const selections = await Promise.all([
        store.selectRevision(select),
        store.selectRevision(select),
      ]);
      expect(selections[0]).toEqual(selections[1]);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toHaveLength(1);
    });

    it("keeps bindings after catalog advancement/removal and rejects rebinding", async () => {
      const first = (await store.installSource(source())).definitions[0];
      const second = (await store.installSource(source("New prompt."))).definitions[0];
      const entry = await store.selectRevision({
        ownerUserId: USER,
        logicalKey: "general",
        revisionId: first.id,
      });
      expect(entry.ok).toBe(true);
      expect(await store.bindThread(THREAD, first.id)).toBe(true);
      expect(await store.bindThread(THREAD, first.id)).toBe(true);
      expect(await store.bindThread(THREAD, second.id)).toBe(false);
      expect(
        await store.selectRevision({
          ownerUserId: USER,
          logicalKey: "general",
          revisionId: second.id,
        }),
      ).toEqual({ ok: false, reason: "conflict" });
      expect(
        (
          await store.selectRevision({
            ownerUserId: USER,
            logicalKey: "general",
            revisionId: second.id,
            expectedRevisionId: first.id,
          })
        ).ok,
      ).toBe(true);
      if (!entry.ok) throw new Error("Catalog creation failed");
      expect(await store.removeOwnedEntry(OTHER, entry.entry.id)).toBe(false);
      expect(await store.removeOwnedEntry(USER, entry.entry.id)).toBe(true);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toEqual([]);
      expect(await store.readThreadBinding(THREAD)).toEqual(first);
      await expect(
        db
          .delete(schema.agentDefinitionRevisions)
          .where(eq(schema.agentDefinitionRevisions.id, first.id)),
      ).rejects.toThrow();
    });

    it("restores a removed entry explicitly while stale saves leave it removed", async () => {
      const first = (await store.installSource(source())).definitions[0];
      const next = (await store.installSource(source("Next"))).definitions[0];
      const selected = await store.selectRevision({
        ownerUserId: USER,
        logicalKey: "general",
        revisionId: first.id,
      });
      if (!selected.ok) throw new Error("Catalog creation failed");
      const id = selected.entry.id;
      await store.removeOwnedEntry(USER, id);
      expect(
        (
          await store.selectRevision({
            ownerUserId: USER,
            logicalKey: "general",
            revisionId: next.id,
            expectedRevisionId: first.id,
          })
        ).ok,
      ).toBe(false);
      expect(await store.restoreOwnedEntry(OTHER, id, first.id)).toBe(false);
      expect(await store.restoreOwnedEntry(USER, id, next.id)).toBe(false);
      expect(await store.restoreOwnedEntry(USER, id, first.id)).toBe(true);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toMatchObject([
        { id, selectedRevisionId: first.id },
      ]);
    });

    it("fences ownership and paginates tied names without duplicates", async () => {
      const id = (await store.installSource(source())).definitions[0].id;
      for (const [ownerUserId, logicalKey] of [
        [USER, "a"],
        [USER, "b"],
        [OTHER, "private"],
        [null, "system"],
      ] as const) {
        await store.selectRevision({ ownerUserId, logicalKey, revisionId: id });
      }
      const all = await store.listCatalog({ userId: USER, limit: 100 });
      expect(all).toHaveLength(3);
      expect(all.map((entry) => entry.logicalKey)).not.toContain("private");
      const page1 = await store.listCatalog({ userId: USER, limit: 1 });
      const page2 = await store.listCatalog({ userId: USER, limit: 2, after: page1[0] });
      expect([...page1, ...page2]).toEqual(all);
      const system = all.find((entry) => entry.ownerUserId === null);
      if (!system) throw new Error("System entry missing");
      expect(await store.removeOwnedEntry(USER, system.id)).toBe(false);
    });

    it("rolls source, catalog, and binding back with the owning transaction", async () => {
      await expect(
        runInDrizzleTransaction(db, async () => {
          const installed = await store.installSource(source());
          await store.selectRevision({
            ownerUserId: USER,
            logicalKey: "general",
            revisionId: installed.definitions[0].id,
          });
          await store.bindThread(THREAD, installed.definitions[0].id);
          throw new Error("Injected admission failure");
        }),
      ).rejects.toThrow("Injected admission failure");
      expect(await db.select().from(schema.agentPackageRevisions)).toEqual([]);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toEqual([]);
      expect(await store.readThreadBinding(THREAD)).toBeUndefined();
    });
  });
}
