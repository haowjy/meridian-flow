/**
 * What a project's placement answers show a writer: the project's own documents and the writer's
 * own `user://` documents, and nothing of another writer's.
 *
 * Pins implementation decisions: the fence is `classifySourceIdentity`, shared by `placed`,
 * `held` and the destination-folder resolver; callers add no filter.
 */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, projects, users, works } from "@meridian/database/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { accountUserSource } from "../../../test-support/branch-tree-seeds.js";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../../test-support/tree-seed.js";
import {
  createDrizzleProjectContextAvailability,
  resolveHeldFolderUri,
} from "./project-context-availability.js";

const enabled = !!process.env.DATABASE_URL && process.env.RUN_DB_TESTS === "1";
describe.skipIf(!enabled)("project context placement privacy", () => {
  const database = useRollbackTestDatabase(process.env.DATABASE_URL ?? "", {
    prepareSuite: (db) => deleteDrizzleRows(db, [users]),
  });
  const id = () => crypto.randomUUID();
  const me = id(),
    other = id(),
    myProject = id(),
    theirProject = id();
  const mine = { doc: id(), folder: "", userDoc: id(), workDoc: id() };
  const theirs = { doc: id(), folder: "", userDoc: id(), workDoc: id() };

  beforeEach(async () => {
    const db = database.current;
    await db
      .insert(users)
      .values([
        conformanceUserValues(me, "placement-me"),
        conformanceUserValues(other, "placement-other"),
      ]);
    await db.insert(projects).values([
      { id: myProject, userId: me, name: "Mine", slug: "mine" },
      { id: theirProject, userId: other, name: "Theirs", slug: "theirs" },
    ]);
    const seed = treeSeeder(db);
    const myWork = id(),
      theirWork = id();
    await db.insert(works).values([
      { id: myWork, projectId: myProject, createdByUserId: me, name: "W", handle: "w1" },
      { id: theirWork, projectId: theirProject, createdByUserId: other, name: "W", handle: "w1" },
    ]);
    const sources = [
      { owner: myProject, slug: "manuscript", held: mine, key: "doc" },
      { account: me, slug: "user", held: mine, key: "userDoc" },
      { owner: theirProject, slug: "manuscript", held: theirs, key: "doc" },
      { account: other, slug: "user", held: theirs, key: "userDoc" },
      { work: myWork, slug: "scratch", held: mine, key: "workDoc" },
      { work: theirWork, slug: "scratch", held: theirs, key: "workDoc" },
    ] as const;
    for (const { slug, held, key, ...ownership } of sources) {
      // The account's home folder is made with the account; the others are inserted here.
      const source =
        "account" in ownership ? await accountUserSource(db, ownership.account as never) : id();
      if (!("account" in ownership))
        await db
          .insert(contextSources)
          .values(
            "work" in ownership
              ? { id: source, workId: ownership.work, scope: "work", slug }
              : { id: source, projectId: ownership.owner, scope: "project", slug },
          );
      await seed.document(source, "note.md", { id: held[key] });
      if (key === "doc") held.folder = await seed.folder(source, "Act 1");
    }
  });

  it("shows a writer their project's and their own user:// nodes, and no one else's", async () => {
    const availability = createDrizzleProjectContextAvailability(database.current);
    const ask = (projectId: string, userId: string) =>
      availability.placed(
        {
          projectId: projectId as never,
          documentIds: [
            mine.doc,
            mine.userDoc,
            mine.workDoc,
            theirs.doc,
            theirs.userDoc,
            theirs.workDoc,
          ],
          folderIds: [mine.folder, theirs.folder],
        },
        { userId },
      );

    const own = await ask(myProject, me);
    expect([...own.documents.keys()].sort()).toEqual([mine.doc, mine.userDoc, mine.workDoc].sort());
    // Absent and silent: a node of another writer's must not even surface as inconsistent.
    expect([...own.inconsistent]).toEqual([]);
    expect(own.documents.get(mine.userDoc)?.authority).toEqual({ kind: "user", userId: me });
    expect([...own.folders.keys()]).toEqual([mine.folder]);

    // The other writer, asking from their own project, gets theirs and none of mine.
    const theirOwn = await ask(theirProject, other);
    expect([...theirOwn.documents.keys()].sort()).toEqual(
      [theirs.doc, theirs.userDoc, theirs.workDoc].sort(),
    );
    expect([...theirOwn.folders.keys()]).toEqual([theirs.folder]);
    expect([...theirOwn.inconsistent]).toEqual([]);

    // The same fence through the by-id lookup and the destination-folder resolver.
    const held = (documentId: string) =>
      availability.held(
        { projectId: myProject as never, node: { kind: "document", id: documentId as never } },
        { userId: me },
      );
    expect((await held(mine.userDoc))?.kind).toBe("held");
    expect((await held(mine.workDoc))?.kind).toBe("held");
    for (const foreign of [theirs.doc, theirs.userDoc, theirs.workDoc]) {
      expect(await held(foreign)).toBeNull();
    }
    expect(await resolveHeldFolderUri(database.current, myProject, me, theirs.folder)).toBeNull();
    expect(await resolveHeldFolderUri(database.current, myProject, me, mine.folder)).toEqual(
      expect.any(String),
    );

    // Another writer's project is refused outright, whatever ids come with it.
    await expect(ask(theirProject, me)).rejects.toThrow("Project not found");
    await expect(ask(myProject, other)).rejects.toThrow("Project not found");
  });
});
