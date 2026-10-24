/**
 * Where #754's identity moves and namespace observation versions meet hidden nodes: a writer's `{ parent, name }` move never lands in a folder only a branch holds, anchored folder creation is a live create (it reveals the branch's hidden folder of that name), and only live changes publish observations.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - live-only namespace observations and hidden-folder reveal on anchored creation (kb/decisions/collab/drafts/model/branch-created-documents-are-hidden-live.md)
 */

import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import { contextAvailabilityHeads, contextCatalogCommits, users } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { branchTreeScenario } from "../../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../../test-support/composed-runtime.js";
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
      const scenario = await branchTreeScenario(db, { runtime, runtimes });
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
        const branch = await scenario.branchOf(ascension);
        const found = await tree.resolvePath(
          { kind: "branch", branchId: branch.id },
          { contextSourceId: manuscript, path },
        );
        if (found.kind !== "found" || found.node.kind !== "folder")
          throw new Error(`The branch holds no folder at ${path}`);
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

    it("refuses a writer's move into a folder only a branch holds as destination_missing", async () => {
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

    it("reveals a branch's hidden folder for anchored creation instead of making a second", async () => {
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

    /** Every catalog change since `cursor` that names a file, folder or source. */
    async function namespaceChanges(s: Awaited<ReturnType<typeof start>>, cursor: string) {
      const delta = await s.runtime.ports.contextCatalog.changes(s.scope, cursor);
      if (delta.kind !== "delta") throw new Error("Expected retained commits");
      return delta.commits
        .flatMap((commit) => commit.changes)
        .filter((change) => change.operation !== "upsert" || change.entry.kind !== "authority");
    }

    it("publishes nothing live, and names no hidden node, when a branch discards its creates", async () => {
      const s = await start();
      await s.scenario.writer.createDocument("chapter", "Chapter one.");
      await s.scenario.writer.createDocument("arc/opening", "The opening.");
      const harbor = await s.model.create("lore/harbor", "The harbor.");
      const lore = await s.hiddenFolder("lore");
      const before = await s.runtime.ports.contextCatalog.snapshot(s.scope);
      const versionBefore = await s.namespaceVersion();
      const known = new Set((await db.select().from(contextCatalogCommits)).map((c) => c.commitId));

      await s.scenario.discard(s.ascension, [harbor as DocumentId]);

      const published = (await db.select().from(contextCatalogCommits))
        .filter((commit) => !known.has(commit.commitId))
        .flatMap((commit) => commit.changes);
      expect(JSON.stringify(published)).not.toContain(harbor);
      expect(JSON.stringify(published)).not.toContain(lore);
      expect(await namespaceChanges(s, before.cursor)).toEqual([]);
      expect(await s.namespaceVersion()).toBe(versionBefore);
    });
  });
}
