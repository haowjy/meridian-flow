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
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { createDrizzleAgentRevisionStore } from "../adapters/drizzle-agent-revision-store.js";
import { createBoundAgentCatalog } from "../domain/bound-agent-catalog.js";
import { seedGeneralAgent } from "../domain/default-package-seeding.js";
import { AgentPublicationConflictError } from "../domain/source-publication.js";

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
        .values({ id: THREAD, projectId: PROJECT, createdByUserId: USER });
    });
    afterAll(() => db.close());

    it("seeds General idempotently and retains its configured model across updates", async () => {
      await seedGeneralAgent(store, "first-model");
      const first = await store.readCatalogEntry(null, "general");
      if (!first) throw new Error("General was not seeded");
      const revision = await store.readRevision(first.selectedRevisionId);
      expect(revision?.definition).toMatchObject({
        systemPrompt: "",
        metadata: { name: "General", mode: "primary", model: "first-model" },
      });
      await seedGeneralAgent(store, "first-model");
      expect(await store.readCatalogEntry(null, "general")).toEqual(first);
      await seedGeneralAgent(store, "next-model");
      const next = await store.readCatalogEntry(null, "general");
      if (!next) throw new Error("General disappeared after reseeding");
      expect(next.selectedRevisionId).not.toBe(first.selectedRevisionId);
      expect((await store.readRevision(first.selectedRevisionId))?.definition.metadata.model).toBe(
        "first-model",
      );
      expect((await store.readRevision(next.selectedRevisionId))?.definition.metadata.model).toBe(
        "next-model",
      );
    });

    it("projects the retained revision through thread reads, lists, and updates", async () => {
      const threads = createDrizzleThreadRepository(db);
      const original = source();
      original.files["agents/general.md"] = original.files["agents/general.md"].replace(
        "name: General",
        "name: Retained Name",
      );
      const first = (await store.installSource(original)).definitions[0];
      await store.bindThread(THREAD, first.id, bindingConfiguration, null);
      expect((await threads.findById(THREAD))?.agentDefinitionRevisionId).toBe(first.id);
      expect((await threads.listByUser(USER))[0]?.agentDefinitionRevisionId).toBe(first.id);
      const updated = await threads.updateStatus(THREAD, "active");
      expect(updated?.agentDefinitionRevisionId).toBe(first.id);
      expect(updated?.agentName).toBe("Retained Name");
      expect((await threads.findById(THREAD))?.agentName).toBe("Retained Name");
      expect((await threads.listByUser(USER))[0]?.agentName).toBe("Retained Name");
    });

    it("labels an agent-less binding as the generic subagent through thread reads", async () => {
      const threads = createDrizzleThreadRepository(db);
      await store.bindThread(THREAD, null, bindingConfiguration, null);
      expect((await threads.findById(THREAD))?.agentDefinitionRevisionId).toBeNull();
      expect((await threads.findById(THREAD))?.agentName).toBe("Subagent");
      expect((await threads.listByUser(USER))[0]?.agentName).toBe("Subagent");
      const updated = await threads.updateStatus(THREAD, "active");
      expect(updated?.agentName).toBe("Subagent");
    });

    it("projects the generic subagent name into the home chat feed for an agent-less binding", async () => {
      const { createDrizzleRepositoriesForTest } = await import(
        "../../threads/adapters/drizzle/repositories.js"
      );
      const repos = createDrizzleRepositoriesForTest(db);
      await store.bindThread(THREAD, null, bindingConfiguration, null);
      const home = await repos.homeFeed.queryPage({
        projectId: PROJECT,
        userId: USER,
        after: null,
        recentLimit: 10,
        includeFeatured: true,
      });
      expect(home.continueChat?.agentName).toBe("Subagent");
    });

    it("chooses one complete prompt-freeze winner across independent connections", async () => {
      const otherDb = createDb(url, { max: 2 });
      try {
        const firstThreads = createDrizzleThreadRepository(db);
        const otherThreads = createDrizzleThreadRepository(otherDb);
        const candidates = [
          { composedSystemPrompt: "First retained prompt", bakedSkillSlugs: ["first-skill"] },
          { composedSystemPrompt: "Second retained prompt", bakedSkillSlugs: ["second-skill"] },
        ];
        const winners = await Promise.all([
          firstThreads.bakeComposedSystemPrompt(THREAD, candidates[0]),
          otherThreads.bakeComposedSystemPrompt(THREAD, candidates[1]),
        ]);
        expect(winners[0].composedSystemPrompt).toBe(winners[1].composedSystemPrompt);
        expect(winners[0].bakedSkillSlugs).toEqual(winners[1].bakedSkillSlugs);
        expect(candidates).toContainEqual({
          composedSystemPrompt: winners[0].composedSystemPrompt,
          bakedSkillSlugs: winners[0].bakedSkillSlugs,
        });
        const reloaded = await otherThreads.findById(THREAD);
        expect(reloaded?.composedSystemPrompt).toBe(winners[0].composedSystemPrompt);
        expect(reloaded?.bakedSkillSlugs).toEqual(winners[0].bakedSkillSlugs);
      } finally {
        await otherDb.close();
      }
    });

    it("retains exact source bytes and definitions across independent connections", async () => {
      const original = source();
      const installed = await store.installSource(original);
      const reopenedDb = createDb(url, { max: 1 });
      try {
        const reopened = createDrizzleAgentRevisionStore(reopenedDb);
        expect(await reopened.readSource(installed.packageRevisionId)).toEqual({
          ...original,
          dependencies: {},
        });
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
      expect(await store.bindThread(THREAD, first.id, bindingConfiguration, null)).toBe(true);
      expect(await store.bindThread(THREAD, first.id, bindingConfiguration, null)).toBe(true);
      expect(await store.bindThread(THREAD, second.id, bindingConfiguration, null)).toBe(false);
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
      const configuration = bindingConfiguration;
      expect(await store.readThreadBinding(THREAD)).toEqual({
        revision: first,
        configuration,
        invocationOverlay: null,
      });
      expect(
        await store.bindThread(
          THREAD,
          first.id,
          { ...configuration, model: "replacement-model" },
          null,
        ),
      ).toBe(false);
      await expect(
        db
          .delete(schema.agentDefinitionRevisions)
          .where(eq(schema.agentDefinitionRevisions.id, first.id)),
      ).rejects.toThrow();
    });

    it("round-trips an agent-less binding with a retained invocation overlay", async () => {
      const configuration = {
        model: "fixture-model",
        skills: { load: [], available: [] },
        namedTargets: [] as Array<{ name: string; definitionRevisionId: string }>,
        tools: { read: "allow" as const },
      };
      const invocationOverlay = {
        systemPrompt: "Replacement body.",
        overrides: { effort: "high" as const },
      };
      expect(await store.bindThread(THREAD, null, configuration, invocationOverlay)).toBe(true);
      expect(await store.readThreadBinding(THREAD)).toEqual({
        revision: null,
        configuration,
        invocationOverlay,
      });
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

    it("authorizes reserved historical revisions without granting unrelated content", async () => {
      const first = (await store.installSource(source())).definitions[0];
      const next = (await store.installSource(source("Next"))).definitions[0];
      const secret = (await store.installSource(source("Private other-account content")))
        .definitions[0];
      const entry = await store.selectRevision({
        ownerUserId: USER,
        logicalKey: "general",
        revisionId: first.id,
      });
      if (!entry.ok) throw new Error("Catalog creation failed");
      expect((await store.readSelection(USER, entry.entry.id, first.id))?.revision.id).toBe(
        first.id,
      );
      expect(await store.readSelection(USER, entry.entry.id, secret.id)).toBeUndefined();
      expect(await store.readSelection(OTHER, entry.entry.id, first.id)).toBeUndefined();
      await store.selectRevision({
        ownerUserId: USER,
        logicalKey: "general",
        revisionId: next.id,
        expectedRevisionId: first.id,
      });
      expect((await store.readSelection(USER, entry.entry.id, first.id))?.revision.id).toBe(
        first.id,
      );
      expect((await store.readSelection(USER, entry.entry.id, next.id))?.revision.id).toBe(next.id);
      expect(await store.readSelection(USER, entry.entry.id, secret.id)).toBeUndefined();
      await store.removeOwnedEntry(USER, entry.entry.id);
      expect(await store.readSelection(USER, entry.entry.id, first.id)).toBeUndefined();
    });

    it("lists and resolves exact catalog revisions with one host support check", async () => {
      const catalog = createBoundAgentCatalog({
        defaultModel: () => "test-model",
        store,
        unavailableReasons: (definition) =>
          definition.metadata.model === "fixture-model" ? [] : ["Model unavailable"],
      });
      await catalog.installSystemSource(source());
      const page = await catalog.list(USER, { limit: 100 });
      expect(page.agents).toHaveLength(1);
      const reserved = page.agents[0].selection;
      expect(page.agents[0].unavailableReasons).toEqual([]);
      await catalog.installSystemSource(source("Updated prompt"));
      const resolved = await catalog.resolvePrimary(USER, reserved);
      expect(resolved).toMatchObject({
        ok: true,
        revision: { definition: { systemPrompt: "Original prompt." } },
      });
      const before = await store.listCatalog({ userId: USER, limit: 100 });
      await expect(
        catalog.installSystemSource({ ...source("Colliding source"), coordinate: "other-source" }),
      ).rejects.toThrow(AgentPublicationConflictError);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toEqual(before);
    });

    it("publishes complete system sources under concurrent updates", async () => {
      const catalog = createBoundAgentCatalog({
        defaultModel: () => "test-model",
        store,
        unavailableReasons: () => [],
      });
      const publication = (version: number) => ({
        coordinate: "concurrent-system",
        files: Object.fromEntries(
          ["a", "b", "c"].map((slug) => [
            `agents/${slug}.md`,
            `---\nname: ${slug}\n---\nv${version}`,
          ]),
        ),
      });
      await catalog.installSystemSource(publication(0));
      await Promise.all(
        Array.from({ length: 12 }, (_, version) =>
          catalog.installSystemSource(publication(version)),
        ),
      );
      const entries = await store.listCatalog({ userId: USER, limit: 100 });
      expect(entries).toHaveLength(3);
      const revisions = await Promise.all(
        entries.map((entry) => store.readRevision(entry.selectedRevisionId)),
      );
      expect(new Set(revisions.map((revision) => revision?.packageRevisionId)).size).toBe(1);
    });

    it("rejects child-only and unsupported revisions consistently in listing and resolution", async () => {
      const catalog = createBoundAgentCatalog({
        defaultModel: () => "test-model",
        store,
        unavailableReasons: () => ["Tools unsupported"],
      });
      await catalog.installSystemSource({
        coordinate: "specialist",
        files: { "agents/child.md": "---\nname: Child\nmode: subagent\n---\n" },
      });
      const page = await catalog.list(USER, { limit: 100 });
      expect(page.agents[0].unavailableReasons).toHaveLength(2);
      expect(await catalog.resolvePrimary(USER, page.agents[0].selection)).toEqual({
        ok: false,
        reason: "unavailable",
        details: page.agents[0].unavailableReasons,
      });
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
          await store.bindThread(THREAD, installed.definitions[0].id, bindingConfiguration, null);
          throw new Error("Injected admission failure");
        }),
      ).rejects.toThrow("Injected admission failure");
      expect(await db.select().from(schema.agentPackageRevisions)).toEqual([]);
      expect(await store.listCatalog({ userId: USER, limit: 100 })).toEqual([]);
      expect(await store.readThreadBinding(THREAD)).toBeUndefined();
    });
  });
}

const bindingConfiguration = {
  model: "fixture-model",
  skills: { load: [], available: [] },
  namedTargets: [],
};
