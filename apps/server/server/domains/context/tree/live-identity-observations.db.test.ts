/**
 * Where #754's identity moves and namespace observation versions meet hidden nodes: a
 * writer's `{ parent, name }` move never lands in a folder only a draft holds, anchored
 * folder creation is a live create (it reveals the draft's hidden folder of that name),
 * and only live changes publish observations. A draft's create publishes nothing; Apply's
 * reveal publishes a newer version; Discard never names a hidden node in a live commit.
 */
import type { DocumentId } from "@meridian/contracts";
import type { CatalogSnapshot } from "@meridian/contracts/protocol";
import { createDb } from "@meridian/database";
import { contextAvailabilityHeads, contextCatalogCommits, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
import { draftTreeScenario } from "../../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../../test-support/drizzle-reset.js";
import { createTreeReader, LIVE_TREE } from "./tree-view.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("identity moves and observations over hidden nodes (postgres)", () => {});
} else {
  describe("identity moves and observations over hidden nodes (postgres)", () => {
    // Creates publish catalog changes in their own transactions, so this suite commits.
    const db = createDb(DATABASE_URL, { max: 8 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);
    const tree = createTreeReader(db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    async function start() {
      const runtime = await runtimes.compose();
      const scenario = await draftTreeScenario(db, { runtime, runtimes });
      const { id: projectId, userId } = scenario.project;
      const ascension = await scenario.work("Ascension", "draft");
      const model = scenario.model(ascension);
      const port = runtime.ports.contextPorts.forProject(projectId, userId, new Map());
      const scope = { kind: "project" as const, projectId };
      const manuscript = scenario.project.sources.manuscript;
      async function namespaceVersion() {
        const [head] = await db
          .select({ version: contextAvailabilityHeads.namespaceGeneration })
          .from(contextAvailabilityHeads)
          .where(eq(contextAvailabilityHeads.authorityKey, `project:${projectId}`));
        return head?.version ?? 0n;
      }
      async function hiddenFolder(path: string) {
        const draft = await scenario.draftOf(ascension);
        const found = await tree.resolvePath(
          { kind: "draft", draftId: draft.id },
          { contextSourceId: manuscript, path },
        );
        if (found.kind !== "found" || found.node.kind !== "folder")
          throw new Error(`The draft holds no folder at ${path}`);
        const live = await tree.resolvePath(LIVE_TREE, { contextSourceId: manuscript, path });
        expect(live.kind).toBe("not_found");
        return found.node.folder.id;
      }
      return {
        runtime,
        scenario,
        ascension,
        model,
        port,
        scope,
        manuscript,
        userId,
        namespaceVersion,
        hiddenFolder,
      };
    }

    it("refuses a writer's move into a folder only a draft holds as destination_missing", async () => {
      const s = await start();
      await s.model.create("lore/harbor", "The harbor.");
      const lore = await s.hiddenFolder("lore");
      const chapter = await s.scenario.writer.createDocument("chapter", "Chapter one.");

      const moved = await s.port.commitWriterLocation(
        "manuscript://chapter",
        "manuscript://lore/chapter",
        {
          origin: { type: "human", userId: s.userId },
          expected: { kind: "file", nodeId: chapter },
          destinationParent: { kind: "folder", folderId: lore },
        },
      );

      expect(moved).toMatchObject({ ok: false, error: { code: "destination_missing" } });
      expect(await s.scenario.view("live").locate(chapter)).toBe("manuscript://chapter");
      await s.hiddenFolder("lore");
    });

    it("reveals a draft's hidden folder for anchored creation instead of making a second", async () => {
      const s = await start();
      await s.model.create("lore/harbor", "The harbor.");
      const lore = await s.hiddenFolder("lore");
      const chapter = await s.scenario.writer.createDocument("chapter", "Chapter one.");

      const moved = await s.port.commitWriterLocation(
        "manuscript://chapter",
        "manuscript://lore/chapter",
        {
          origin: { type: "human", userId: s.userId },
          expected: { kind: "file", nodeId: chapter },
          destinationParent: {
            kind: "root",
            scheme: "manuscript",
            owner: { workId: null },
            createFolders: ["lore"],
          },
        },
      );

      expect(moved).toMatchObject({ ok: true, value: { destinationPath: "lore/chapter" } });
      const live = await tree.resolvePath(LIVE_TREE, {
        contextSourceId: s.manuscript,
        path: "lore",
      });
      expect(live).toMatchObject({ kind: "found", node: { kind: "folder", folder: { id: lore } } });
      expect(await s.scenario.view("live").locate(chapter)).toBe("manuscript://lore/chapter");
    });

    it("publishes no namespace observation for a draft's create and a newer one for Apply's reveal", async () => {
      const s = await start();
      await s.scenario.writer.createDocument("chapter", "Chapter one.");
      const before = await s.runtime.ports.contextCatalog.snapshot(s.scope);
      const harbor = await s.model.create("lore/harbor", "The harbor.");
      const lore = await s.hiddenFolder("lore");

      // Source resolution and the Work's pending count republish live state (as on main);
      // none of it names, places or counts the draft's hidden nodes.
      const afterCreate = await s.runtime.ports.contextCatalog.changes(s.scope, before.cursor);
      if (afterCreate.kind !== "delta") throw new Error("Expected retained commits");
      const published = JSON.stringify(afterCreate.commits.flatMap((commit) => commit.changes));
      expect(published).not.toContain(harbor);
      expect(published).not.toContain(lore);
      const namespace = (entries: CatalogSnapshot["entries"]) =>
        entries.flatMap((entry) => {
          if (entry.kind !== "file" && entry.kind !== "folder") return [];
          const { observationVersion: _version, ...rest } = entry;
          return [rest];
        });
      const afterSnapshot = await s.runtime.ports.contextCatalog.snapshot(s.scope);
      expect(namespace(afterSnapshot.entries)).toEqual(namespace(before.entries));
      const versionAfterCreate = await s.namespaceVersion();

      await s.scenario.apply(s.ascension, [harbor]);

      const versionAfter = await s.namespaceVersion();
      expect(versionAfter).toBeGreaterThan(versionAfterCreate);
      const revealed = (await s.runtime.ports.contextCatalog.snapshot(s.scope)).entries.find(
        (entry) => entry.entryId === harbor,
      );
      expect(revealed).toMatchObject({ kind: "file", observationVersion: String(versionAfter) });
      const changes = await s.runtime.ports.contextCatalog.changes(s.scope, before.cursor);
      if (changes.kind !== "delta") throw new Error("Expected Apply's catalog commit");
      expect(
        changes.commits
          .flatMap((commit) => commit.changes)
          .some((change) => change.operation === "upsert" && change.entry.entryId === harbor),
      ).toBe(true);
    });

    it("names no hidden node in a live catalog commit when a draft discards its creates", async () => {
      const s = await start();
      await s.scenario.writer.createDocument("chapter", "Chapter one.");
      const harbor = await s.model.create("lore/harbor", "The harbor.");
      const lore = await s.hiddenFolder("lore");
      const before = await db.select().from(contextCatalogCommits);

      await s.scenario.discard(s.ascension, [harbor as DocumentId]);

      const known = new Set(before.map((commit) => commit.commitId));
      const published = (await db.select().from(contextCatalogCommits))
        .filter((commit) => !known.has(commit.commitId))
        .flatMap((commit) => commit.changes);
      expect(JSON.stringify(published)).not.toContain(harbor);
      expect(JSON.stringify(published)).not.toContain(lore);
    });
  });
}
