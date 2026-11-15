/**
 * What a project's placement answers show a writer: the project's own documents and the writer's
 * own `user://` documents, and nothing of another writer's.
 *
 * Pins implementation decisions: the fence is the port's actor check plus the source-ownership
 * check inside `placed`, not a filter in its callers.
 */

import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, projects, users } from "@meridian/database/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteDrizzleRows, useRollbackTestDatabase } from "../../../test-support/drizzle-reset.js";
import { treeSeeder } from "../../../test-support/tree-seed.js";
import { createDrizzleProjectContextAvailability } from "./project-context-availability.js";

const enabled = !!process.env.DATABASE_URL && process.env.RUN_DB_TESTS === "1";
describe.skipIf(!enabled)("project context placement privacy", () => {
  const database = useRollbackTestDatabase(process.env.DATABASE_URL ?? "", {
    prepareSuite: (db) => deleteDrizzleRows(db, [users]),
  });
  const id = () => crypto.randomUUID();
  const me = id(),
    other = id(),
    myProject = id(),
    myAccount = id(),
    theirProject = id(),
    theirAccount = id();
  const mine = { doc: id(), folder: "", userDoc: id() };
  const theirs = { doc: id(), folder: "", userDoc: id() };

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
      { id: myAccount, userId: me, name: "Personal", slug: "personal", isPersonal: true },
      { id: theirProject, userId: other, name: "Theirs", slug: "theirs" },
      { id: theirAccount, userId: other, name: "Personal", slug: "personal", isPersonal: true },
    ]);
    const seed = treeSeeder(db);
    const sources = [
      { owner: myProject, slug: "manuscript", held: mine, key: "doc" },
      { owner: myAccount, slug: "user", held: mine, key: "userDoc" },
      { owner: theirProject, slug: "manuscript", held: theirs, key: "doc" },
      { owner: theirAccount, slug: "user", held: theirs, key: "userDoc" },
    ] as const;
    for (const { owner, slug, held, key } of sources) {
      const source = id();
      await db
        .insert(contextSources)
        .values({ id: source, projectId: owner, scope: "project", slug, name: slug });
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
          documentIds: [mine.doc, mine.userDoc, theirs.doc, theirs.userDoc],
          folderIds: [mine.folder, theirs.folder],
        },
        { userId },
      );

    const own = await ask(myProject, me);
    expect([...own.documents.keys()].sort()).toEqual([mine.doc, mine.userDoc].sort());
    expect(own.documents.get(mine.userDoc)?.authority).toEqual({ kind: "user", userId: me });
    expect([...own.folders.keys()]).toEqual([mine.folder]);

    // The other writer, asking from their own project, gets theirs and none of mine.
    const theirOwn = await ask(theirProject, other);
    expect([...theirOwn.documents.keys()].sort()).toEqual([theirs.doc, theirs.userDoc].sort());
    expect([...theirOwn.folders.keys()]).toEqual([theirs.folder]);

    // Another writer's project is refused outright, whatever ids come with it.
    await expect(ask(theirProject, me)).rejects.toThrow("Project not found");
    await expect(ask(myProject, other)).rejects.toThrow("Project not found");
  });
});
