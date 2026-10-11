/**
 * Drafted `user://` (D20 under 12b): a draft-mode Work in any project of the account drafts
 * into the account's personal source, hidden live until Apply, and one hidden document is
 * shared by every draft of the account that uses it. Another account's source is never a
 * draft's.
 */
import type { DocumentId } from "@meridian/contracts";
import { documentBranches, documents, draftTreeChanges } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { createDrizzleBranchStore } from "./adapters/drizzle-branches.js";

describeDraftTreeDb("Drafted user:// (postgres)", (start, db) => {
  const rows = (ids: readonly DocumentId[]) =>
    db
      .select({
        id: documents.id,
        hidden: documents.hidden,
        deleted: documents.deletedAt,
        source: documents.contextSourceId,
      })
      .from(documents)
      .where(inArray(documents.id, [...ids]));

  it("drafts a create, a nested create, a copy and an edit into user:// from a non-personal project", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    await s.writer.createDocument("user://existing.md", "Old note.");
    await s.writer.createDocument("chapter.md", "Chapter text.");
    const model = s.model(ascension);
    const kael = await model.create("user://kael.md", "Kael.");
    const peak = await model.create("user://notes/deep/peak.md", "Peak.");
    await model.copy("chapter.md", "user://copy.md");
    await model.edit("user://existing.md", "Old note.", "New note.");

    const a = s.view(ascension);
    const live = s.view("live");
    for (const [path, text] of [
      ["user://kael.md", "Kael."],
      ["user://notes/deep/peak.md", "Peak."],
      ["user://copy.md", "Chapter text."],
      ["user://existing.md", "New note."],
    ] as const) {
      expect.soft(await a.text(path), `the Work reads ${path}`).toContain(text);
    }
    expect.soft(await live.text("user://existing.md"), "live keeps its text").toContain("Old");
    for (const path of ["user://kael.md", "user://notes/deep/peak.md", "user://copy.md"]) {
      expect.soft(await live.idAt(path), `${path} is hidden live`).toBeNull();
    }
    expect
      .soft((await s.items(ascension)).map((item) => item.path).sort(), "four review items")
      .toEqual([
        "user://copy.md",
        "user://existing.md",
        "user://kael.md",
        "user://notes/deep/peak.md",
      ]);
    expect.soft(await rows([kael, peak]), "hidden rows in the personal source").toEqual(
      expect.arrayContaining(
        [kael, peak].map((id) => ({
          id,
          hidden: true,
          deleted: null,
          source: s.project.sources.user,
        })),
      ),
    );
  });

  it("applies a user:// item alone, then a mixed Apply all into each item's own source", async () => {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const model = s.model(ascension);
    const kael = await model.create("user://kael.md", "Kael.");
    const chapter = await model.create("chapter-one.md", "One.");
    const peak = await model.create("user://notes/peak.md", "Peak.");
    const live = s.view("live");
    const { contextCatalog } = runtime.ports;
    const personal = { kind: "user" as const, userId: s.project.userId };
    const project = { kind: "project" as const, projectId: s.project.id };
    const before = {
      personal: await contextCatalog.snapshot(personal),
      project: await contextCatalog.snapshot(project),
    };
    expect.soft(JSON.stringify(await live.ls("user://")), "hidden live").not.toContain("kael");

    expect
      .soft(await s.apply(ascension, [kael]))
      .toMatchObject([{ httpStatus: 200, body: { status: "applied" } }]);
    expect.soft(await live.text("user://kael.md")).toContain("Kael.");
    expect.soft(JSON.stringify(await live.ls("user://")), "listed live").toContain("kael.md");

    expect
      .soft(await s.applyAll(ascension), "both sources in one Apply all")
      .toMatchObject({ status: "completed", draftClosed: true });
    expect.soft(await live.idAt("chapter-one.md")).toBe(chapter);
    expect.soft(await live.idAt("user://notes/peak.md")).toBe(peak);
    const personalChanges = JSON.stringify(
      await contextCatalog.changes(personal, before.personal.cursor),
    );
    expect.soft(personalChanges, "the personal catalog learns Kael").toContain(kael);
    expect.soft(personalChanges, "and Peak").toContain(peak);
    expect
      .soft(JSON.stringify(await contextCatalog.changes(project, before.project.cursor)))
      .toContain(chapter);
  });

  it("shares one hidden user:// document across the account's projects until its last draft ends", async () => {
    const { s } = await start();
    const other = await s.another("project");
    const ascension = await s.work("Ascension", "draft");
    const beacon = await other.work("Beacon", "draft");
    const shared = await s.model(ascension).create("user://shared.md", "Ascension's.");
    expect
      .soft(await other.model(beacon).create("user://shared.md", "Beacon's."), "joined")
      .toBe(shared);

    await s.discard(ascension, "all");
    expect
      .soft(await rows([shared]), "Beacon still uses it")
      .toMatchObject([{ hidden: true, deleted: null }]);
    expect.soft(await other.view(beacon).text("user://shared.md")).toContain("Beacon's.");

    await other.purge(beacon);
    const [row] = await rows([shared]);
    expect.soft(row?.deleted, "tombstoned at the last use").not.toBeNull();
  });

  it("reveals the account's hidden user:// document from any of its projects, never a stranger's", async () => {
    const { s } = await start();
    const other = await s.another("project");
    const stranger = await s.another("account");
    const ascension = await s.work("Ascension", "draft");
    const kael = await s.model(ascension).create("user://kael.md", "Kael.");

    const cinder = await stranger.work("Cinder", "draft");
    const draft = await stranger.draftOf(cinder);
    const branches = createDrizzleBranchStore(db, { drafts: stranger.drafts });
    await expect(
      branches.ensureDraftBranch({ documentId: kael, draftId: draft.id, liveDoc: new Y.Doc() }),
      "a stranger's draft",
    ).rejects.toThrow();
    expect
      .soft(
        await db
          .select({ id: documentBranches.id })
          .from(documentBranches)
          .where(
            and(eq(documentBranches.documentId, kael), eq(documentBranches.draftId, draft.id)),
          ),
      )
      .toEqual([]);
    expect
      .soft(
        await db
          .select({ id: draftTreeChanges.nodeId })
          .from(draftTreeChanges)
          .where(eq(draftTreeChanges.draftId, draft.id)),
      )
      .toEqual([]);
    expect
      .soft(await stranger.writer.create("user://kael.md", { documentId: kael }), "stranger")
      .toEqual({ status: "conflict" });

    // Reveal authority is per document: a draft in Ascension's project uses it, and the
    // writer reveals it from another project of the same account.
    expect
      .soft(await other.writer.create("user://kael.md", { documentId: kael }))
      .toEqual({ status: "created", documentId: kael });
  });

  it("keeps a draft's hidden file in a folder the writer moves from the project into user://", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const map = await s.writer.createDocument("lore/map.md", "Map.");
    const notes = await s.model(ascension).create("lore/notes.md", "Notes.");
    expect.soft(await s.writer.move("lore", "user://lore")).toMatchObject({ ok: true });
    expect.soft(await s.view("live").idAt("user://lore/map.md")).toBe(map);
    expect.soft(await s.view("live").idAt("user://lore/notes.md"), "still hidden").toBeNull();
    expect.soft(await s.view(ascension).idAt("user://lore/notes.md"), "carried").toBe(notes);
  });
});
