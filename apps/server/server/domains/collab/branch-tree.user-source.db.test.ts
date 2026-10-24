/**
 * Drafted `user://` (D20 under 12b): a draft-mode Work in any project of the account branches into the account's personal source, hidden live until Apply, and one hidden document is shared by every branch of the account that uses it.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current branch tree user source persistence protocol (kb/decisions/collab/drafts/model/shared-branch-per-work.md)
 */

import type { DocumentId } from "@meridian/contracts";
import { branchTreeChanges, documentDrafts, documents } from "@meridian/database/schema";
import { and, eq, inArray } from "drizzle-orm";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { createTestWorkProjectionMutation } from "../../test-support/work-projection.js";
import { createDraftClose } from "./adapters/drizzle-draft-close.js";
import { createDrizzleDraftStore } from "./adapters/drizzle-drafts.js";

describeBranchTreeDb("Drafted user:// (postgres)", (start, db) => {
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

  it("branches a create, a nested create, a copy and an edit into user:// from a non-personal project", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    await s.writer.createDocument("user://existing", "Old note.");
    await s.writer.createDocument("chapter", "Chapter text.");
    const model = s.model(ascension);
    const kael = await model.create("user://kael", "Kael.");
    const peak = await model.create("user://notes/deep/peak", "Peak.");
    await model.copy("chapter", "user://copy");
    await model.edit("user://existing", "Old note.", "New note.");

    const a = s.view(ascension);
    const live = s.view("live");
    for (const [path, text] of [
      ["user://kael", "Kael."],
      ["user://notes/deep/peak", "Peak."],
      ["user://copy", "Chapter text."],
      ["user://existing", "New note."],
    ] as const) {
      expect.soft(await a.text(path), `the Work reads ${path}`).toContain(text);
    }
    expect.soft(await live.text("user://existing"), "live keeps its text").toContain("Old");
    for (const path of ["user://kael", "user://notes/deep/peak", "user://copy"]) {
      expect.soft(await live.idAt(path), `${path} is hidden live`).toBeNull();
    }
    expect
      .soft(
        (await s.items(ascension))
          .map((item) => `${item.contextLocation?.scheme}://${item.contextLocation?.path.slice(1)}`)
          .sort(),
        "four review items",
      )
      .toEqual(["user://copy", "user://existing", "user://kael", "user://notes/deep/peak"]);
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

  it("shares one hidden user:// document across the account's projects until its last branch ends", async () => {
    const { s } = await start();
    const other = await s.another("project");
    const ascension = await s.work("Ascension", "draft");
    const beacon = await other.work("Beacon", "draft");
    const shared = await s.model(ascension).create("user://shared", "Ascension's.");
    expect
      .soft(await other.model(beacon).create("user://shared", "Beacon's."), "joined")
      .toBe(shared);

    await s.discard(ascension, "all");
    expect
      .soft(await rows([shared]), "Beacon still uses it")
      .toMatchObject([{ hidden: true, deleted: null }]);
    expect.soft(await other.view(beacon).text("user://shared")).toContain("Beacon's.");

    await other.purge(beacon);
    const [row] = await rows([shared]);
    expect.soft(row?.deleted, "tombstoned at the last use").not.toBeNull();
  });

  it("reveals the account's hidden user:// document from any of its projects and never lets a stranger's branch use it", async () => {
    const { s } = await start();
    const other = await s.another("project");
    const stranger = await s.another("account");
    const ascension = await s.work("Ascension", "draft");
    const kael = await s.model(ascension).create("user://kael", "Kael.");

    const cinder = await stranger.work("Cinder", "draft");
    const branch = await stranger.branchOf(cinder);
    const drafts = createDrizzleDraftStore(db, {
      close: createDraftClose(),
      workProjection: createTestWorkProjectionMutation(db),
      branches: stranger.branches,
    });
    await expect(
      drafts.ensureDocumentDraft({
        documentId: kael,
        branchId: branch.id,
        liveDoc: new Y.Doc(),
        liveRoom: null,
      }),
      "a stranger's branch",
    ).rejects.toThrow();
    expect
      .soft(
        await db
          .select({ id: documentDrafts.id })
          .from(documentDrafts)
          .where(and(eq(documentDrafts.documentId, kael), eq(documentDrafts.branchId, branch.id))),
      )
      .toEqual([]);
    expect
      .soft(
        await db
          .select({ id: branchTreeChanges.nodeId })
          .from(branchTreeChanges)
          .where(eq(branchTreeChanges.branchId, branch.id)),
      )
      .toEqual([]);

    // The source is the account's: a branch in Ascension's project uses the document, and
    // the writer's create at its path reveals it from another project of the same account.
    expect
      .soft(await other.writer.create("user://kael"))
      .toEqual({ status: "created", documentId: kael });
  });

  it("keeps a branch's hidden file in a folder the writer moves from the project into user://", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const map = await s.writer.createDocument("lore/map", "Map.");
    const notes = await s.model(ascension).create("lore/notes", "Notes.");
    expect.soft(await s.writer.move("lore", "user://lore")).toMatchObject({ ok: true });
    expect.soft(await s.view("live").idAt("user://lore/map")).toBe(map);
    expect.soft(await s.view("live").idAt("user://lore/notes"), "still hidden").toBeNull();
    expect.soft(await s.view(ascension).idAt("user://lore/notes"), "carried").toBe(notes);
  });
});
