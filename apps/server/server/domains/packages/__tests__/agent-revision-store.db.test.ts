/**
 * Postgres contracts for retained Agent identity, transactional binding and a package's Saves.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Agent-less binding overlays
 * - A package's saved version is its newest Save row; Undo appends the row before it
 */
import { createDb } from "@meridian/database";
import {
  assertThrowawayDatabaseForRunDbTests,
  conformanceUserValues,
} from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createDrizzleLineageScratchLifecycle } from "../../context/adapters/lineage-scratch-lifecycle.js";
import { createDrizzleThreadRepository } from "../../threads/adapters/drizzle/thread-repository.js";
import { hashPromptBakeContent } from "../../threads/domain/prompt-bake-hash.js";
import { createDrizzleAgentRevisionStore } from "../adapters/drizzle-agent-revision-store.js";

const USER = "00000000-0000-4000-8000-000000000871";
const PROJECT = "00000000-0000-4000-8000-000000000873";
const THREAD = "00000000-0000-4000-8000-000000000874";
const url = process.env.DATABASE_URL;
const MANIFEST = '[package]\nname = "fixture"\nversion = "0.1.0"\nschema = 1\n';
const source = (body = "Original prompt.") => ({
  coordinate: "fixture/agents",
  files: {
    "mars.toml": MANIFEST,
    "agents/general.md": `---\nname: General\nmodel: fixture-model\n---\n\n${body}`,
    "skills/voice/SKILL.md": "---\nname: voice\ndescription: How to sound.\n---\n\nVoice guidance.",
    "skills/voice/reference.txt": "Reference text.",
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
      await deleteDrizzleRows(db, [schema.users, schema.agentPackageRevisions]);
      await db.insert(schema.users).values(conformanceUserValues(USER, "agent-owner"));
      await db
        .insert(schema.projects)
        .values({ id: PROJECT, userId: USER, name: "Agents", slug: "agents" });
      await db.insert(schema.threads).values({
        rootThreadId: THREAD,
        id: THREAD,
        projectId: PROJECT,
        createdByUserId: USER,
      });
    });
    afterAll(() => db.close());

    it("chooses one complete prompt-freeze winner across independent connections", async () => {
      const otherDb = createDb(url, { max: 2 });
      try {
        const firstThreads = createDrizzleThreadRepository(db, {
          lineageScratch: createDrizzleLineageScratchLifecycle(db),
        });
        const otherThreads = createDrizzleThreadRepository(otherDb, {
          lineageScratch: createDrizzleLineageScratchLifecycle(otherDb),
        });
        const candidates = [
          {
            composedSystemPrompt: "First retained prompt",
            bakedSkillSlugs: ["first-skill"],
            bakedTools: [],
          },
          {
            composedSystemPrompt: "Second retained prompt",
            bakedSkillSlugs: ["second-skill"],
            bakedTools: [],
          },
        ];
        const inputs = candidates.map((candidate) => ({
          ...candidate,
          contentHash: hashPromptBakeContent(candidate),
        }));
        const winners = await Promise.all([
          firstThreads.bakeInitialPrompt(THREAD, inputs[0]),
          otherThreads.bakeInitialPrompt(THREAD, inputs[1]),
        ]);
        expect(winners[0].bake).toEqual(winners[1].bake);
        expect(candidates).toContainEqual({
          composedSystemPrompt: winners[0].bake.composedSystemPrompt,
          bakedSkillSlugs: winners[0].bake.bakedSkillSlugs,
          bakedTools: winners[0].bake.bakedTools,
        });
        const reloaded = await otherThreads.findById(THREAD);
        expect(reloaded?.initialPromptBakeId).toBe(winners[0].bake.id);
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
        expect(await reopened.readSource(installed.packageRevisionId)).toEqual(original);
        expect(await reopened.readCatalogRevision(installed.definitions[0].id)).toEqual(
          installed.definitions[0],
        );
        expect(await reopened.installSource(original)).toEqual(installed);
      } finally {
        await reopenedDb.close();
      }
    });

    it("deduplicates concurrent installs", async () => {
      const installs = await Promise.all([
        store.installSource(source()),
        store.installSource(source()),
      ]);
      expect(installs[0]).toEqual(installs[1]);
    });

    it("keeps a binding on its revision when the files move on", async () => {
      const first = (await store.installSource(source())).definitions[0];
      const second = (await store.installSource(source("New prompt."))).definitions[0];
      expect(await store.bindThread(THREAD, first.id, bindingConfiguration, null)).toBe(true);
      expect(await store.bindThread(THREAD, first.id, bindingConfiguration, null)).toBe(true);
      expect(await store.bindThread(THREAD, second.id, bindingConfiguration, null)).toBe(false);
      expect(await store.readThreadBinding(THREAD)).toEqual({
        revision: await store.readRevision(first.id),
        configuration: bindingConfiguration,
        invocationOverlay: null,
        invokedSkills: {},
      });
      expect(
        await store.bindThread(
          THREAD,
          first.id,
          { ...bindingConfiguration, model: "replacement-model" },
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
        permission: "edit" as const,
        tools: ["read"],
      };
      const invocationOverlay = {
        appendSystemPrompt: "Appended body.",
        overrides: { effort: "high" as const },
      };
      expect(await store.bindThread(THREAD, null, configuration, invocationOverlay)).toBe(true);
      expect(await store.readThreadBinding(THREAD)).toEqual({
        revision: null,
        configuration,
        invocationOverlay,
        invokedSkills: {},
      });
    });

    it("rolls source and binding back with the owning transaction", async () => {
      await expect(
        runInDrizzleTransaction(db, async () => {
          const installed = await store.installSource(source());
          await store.bindThread(THREAD, installed.definitions[0].id, bindingConfiguration, null);
          throw new Error("Injected admission failure");
        }),
      ).rejects.toThrow("Injected admission failure");
      expect(await db.select().from(schema.agentPackageRevisions)).toEqual([]);
      expect(await store.readThreadBinding(THREAD)).toBeUndefined();
    });

    it("replaces a binding with the owning transaction, keeping the overlay and later pins", async () => {
      const [first, second] = [source("One."), source("Two.")].map(
        async (files) => (await store.installSource(files)).definitions[0],
      );
      const [one, two] = [await first, await second];
      const overlay = { appendSystemPrompt: "Be brief." };
      await store.bindThread(THREAD, one.id, bindingConfiguration, overlay);
      const pin = { packageRevisionId: "p", path: "skills/voice/SKILL.md", contentDigest: "d" };
      await store.recordInvokedSkill(THREAD, "voice", pin);
      await expect(
        runInDrizzleTransaction(db, async () => {
          await store.replaceThreadBinding(THREAD, two.id, bindingConfiguration, {});
          throw new Error("Injected boundary failure");
        }),
      ).rejects.toThrow("Injected boundary failure");
      expect((await store.readThreadBinding(THREAD))?.revision?.id).toBe(one.id);
      await store.replaceThreadBinding(THREAD, two.id, bindingConfiguration, {
        voice: { ...pin, contentDigest: "e" },
      });
      expect(await store.readThreadBinding(THREAD)).toMatchObject({
        revision: { id: two.id },
        invocationOverlay: overlay,
        invokedSkills: { voice: { contentDigest: "e" } },
      });
    });

    describe("Saves", () => {
      const owner = { userId: USER };
      const retain = async (body: string) =>
        (await store.installSource(source(body))).packageRevisionId;

      it("reads a package's newest Save, and Undo adds the row before it", async () => {
        const [a, b] = [await retain("A"), await retain("B")];
        await store.savePackage(owner, "", a);
        const second = await store.savePackage(owner, "", b);
        expect((await store.readSaved(owner)).map((row) => row.packageRevisionId)).toEqual([b]);
        const seen: unknown[] = [];
        const undone = await store.undoSave(owner, second.id, async (was, target) => {
          seen.push([was.packageRevisionId, target?.packageRevisionId]);
        });
        expect(seen).toEqual([[b, a]]);
        expect(undone?.undone?.id).toBe(second.id);
        expect((await store.readSaved(owner)).map((row) => row.packageRevisionId)).toEqual([a]);
        // A Save with a later one on top is no longer the one to undo.
        expect((await store.undoSave(owner, second.id, async () => {}))?.undone).toBeNull();
      });

      it("rolls the row back with a restore that throws", async () => {
        await store.savePackage(owner, "", await retain("Before"));
        const first = await store.savePackage(owner, "", await retain("A"));
        await expect(
          store.undoSave(owner, first.id, async () => {
            throw new Error("A file would not merge");
          }),
        ).rejects.toThrow("A file would not merge");
        expect((await store.readSaved(owner)).map((row) => row.id)).toEqual([first.id]);
      });

      it("orders a Save that arrives during an Undo after it", async () => {
        const [a, b, c] = [await retain("A"), await retain("B"), await retain("C")];
        await store.savePackage(owner, "", a);
        const latest = await store.savePackage(owner, "", b);
        const otherDb = createDb(url, { max: 2 });
        try {
          const rival = createDrizzleAgentRevisionStore(otherDb);
          let release = () => {};
          let inside = () => {};
          const held = new Promise<void>((resolve) => (release = resolve));
          const reached = new Promise<void>((resolve) => (inside = resolve));
          const undo = store.undoSave(owner, latest.id, async () => {
            inside();
            await held;
          });
          await reached;
          const save = rival.savePackage(owner, "", c);
          // The rival is waiting on the package lock the Undo holds.
          await vi.waitFor(async () => {
            const waiting =
              await db.$client`select 1 from pg_locks where locktype = 'advisory' and not granted`;
            expect(waiting.length).toBeGreaterThan(0);
          });
          release();
          expect((await undo)?.undone?.id).toBe(latest.id);
          await save;
          expect((await store.readSaved(owner)).map((row) => row.packageRevisionId)).toEqual([c]);
        } finally {
          await otherDb.close();
        }
      });
    });
  });
}

const bindingConfiguration = {
  model: "fixture-model",
  skills: { load: [], available: [] },
  namedTargets: [],
  permission: "edit" as const,
};
