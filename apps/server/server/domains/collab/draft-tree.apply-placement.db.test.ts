/**
 * Apply's tree work (contract §11.2, ledger E-1, E-2, E-4, E-8): a create the writer also
 * made live merges and a live rename is named back, a second draft sees only its part of a
 * shared create, a create applies at its path after a live folder rename absorbed its
 * hidden folder, and a document deleted live is restored with its folder unless another
 * document took its path. Driven through the review route cores.
 */
import { folders } from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";

describeDraftTreeDb("Apply's tree work (postgres)", (start, db) => {
  it("merges a create the writer also made live, names a live rename back, and refuses the model's later create usefully (E-1)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const kael = await s.model(ascension).create("characters/kael.md", "Kael guards the gate.");
    const hidden = await s.review(ascension);
    expect.soft(itemFor(hidden.items, kael), "new while hidden").toMatchObject({
      origin: "created",
      isNew: true,
      path: "manuscript://characters/kael.md",
      conflict: null,
    });
    expect
      .soft(hidden.drafts, "the legacy list shows it too, as new (early probe 1, 4)")
      .toMatchObject([
        { documentId: kael, contextPath: "/characters/kael.md", isNewDocument: true },
      ]);

    // The writer makes it live: one document, D's own.
    const made = await s.writer.create("characters/kael.md", { content: "Writer's Kael." });
    expect.soft(made, "the live create reveals D's document").toEqual({
      status: "created",
      documentId: kael,
    });
    // After the reveal it is an existing file: the model's create is refused, with guidance.
    const refused = await s.model(ascension).now("write", {
      command: "create",
      path: "manuscript://characters/kael.md",
      content: "A second Kael.",
    });
    expect
      .soft(JSON.stringify(refused.output), "create after reveal")
      .toContain("Read it, then edit it");

    // The writer renames it live; Apply names it back at the draft's location.
    expect
      .soft(await s.writer.move("characters/kael.md", "characters/kael-fix.md"))
      .toMatchObject({ ok: true });
    await s.writer.write("characters/kael-fix.md", "Writer's Kael.\n\nThe writer's second line.");
    const reviewed = itemFor(await s.items(ascension), kael);
    expect.soft(reviewed, "revealed, then renamed live").toMatchObject({
      isNew: false,
      path: "manuscript://characters/kael.md",
      livePath: "manuscript://characters/kael-fix.md",
      conflict: { code: "rename_replaced", livePath: "manuscript://characters/kael-fix.md" },
    });
    expect.soft(await s.applyAll(ascension), "one command, one publication").toEqual({
      status: "applied",
      draftId: reviewed.draftId,
      draftClosed: true,
      items: [
        {
          itemKey: reviewed.itemKey,
          status: "applied",
          notes: [
            {
              code: "rename_replaced",
              replacedPath: "manuscript://characters/kael-fix.md",
              path: "manuscript://characters/kael.md",
            },
          ],
        },
      ],
    });
    const live = s.view("live");
    expect.soft(await live.idAt("characters/kael.md"), "named back").toBe(kael);
    expect.soft(await live.idAt("characters/kael-fix.md"), "the rename's path freed").toBeNull();
    const text = await live.text("characters/kael.md");
    expect.soft(text, "the draft's text").toContain("Kael guards the gate.");
    expect.soft(text, "the writer's live edit").toContain("The writer's second line.");
    expect.soft(await s.draftStatuses(ascension), "nothing pending: D closed").toEqual(["closed"]);
  });

  it("shows a second draft only its own part after the first applies their shared create (E-2)", async () => {
    const { runtime, s } = await start();
    const [ascension, beacon] = [
      await s.work("Ascension", "draft"),
      await s.work("Beacon", "draft"),
    ];
    const kael = await s.model(ascension).create("characters/kael.md", "Ascension's Kael.");
    const joined = await s.model(beacon).create("characters/kael.md", "Beacon's Kael.");
    expect.soft(joined, "both drafts use one hidden document").toBe(kael);

    expect.soft((await s.applyAll(ascension)).status).toBe("applied");
    expect.soft(await s.view("live").text("characters/kael.md")).toContain("Ascension's Kael.");
    const [item] = await s.items(beacon);
    expect.soft(item, "Beacon still has it, no longer new").toMatchObject({
      documentId: kael,
      origin: "created",
      isNew: false,
      conflict: null,
    });
    const preview = await runtime.ports.documentSync.draftReview.preview({
      workId: beacon.id,
      documentId: kael,
      draftId: item?.draftBranchId ?? "",
    });
    if (preview.status !== "active") throw new Error("Beacon's review is gone");
    const excerpts = preview.operations.map((operation) => operation.afterExcerpt ?? "");
    expect.soft(excerpts.join(" "), "Beacon's part").toContain("Beacon's Kael.");
    expect.soft(excerpts.join(" "), "never Ascension's").not.toContain("Ascension's Kael.");
    expect.soft(preview.live, "live is Ascension's").toContain("Ascension's Kael.");
    expect.soft(preview.item?.isNew, "the preview's item").toBe(false);
  });

  it("applies at the right path after a live folder rename absorbed the draft's hidden folder (E-4)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const notes = await s.model(ascension).create("ideas/kael/notes.md", "Notes.");
    const plan = await s.writer.createDocument("drafts/plan.md", "Plan.");
    expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });
    const [item] = await s.items(ascension);
    expect.soft(item, "still new, at its path").toMatchObject({
      documentId: notes,
      isNew: true,
      path: "manuscript://ideas/kael/notes.md",
      conflict: null,
    });
    // The legacy per-document Apply of a hidden create (early probe 2: it answered 404).
    expect.soft(await s.apply(ascension, [notes], { tokens: "none" })).toEqual([
      {
        httpStatus: 200,
        body: {
          status: "applied",
          draftId: item?.draftBranchId,
          item: { itemKey: item?.itemKey, status: "applied", notes: [] },
        },
      },
    ]);
    const live = s.view("live");
    expect.soft(await live.idAt("ideas/kael/notes.md"), "at the draft's path").toBe(notes);
    expect.soft(await live.idAt("ideas/plan.md"), "the renamed folder's file").toBe(plan);
    const ideas = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.name, "ideas"), sql`${folders.deletedAt} IS NULL`));
    expect.soft(ideas, "one live ideas folder").toHaveLength(1);
  });

  it("restores an edited document deleted live with its folder, and holds one whose path a new document took (E-8)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const harbor = await s.writer.createDocument("lore/harbor.md", "The harbor.");
    const map = await s.writer.createDocument("atlas/map.md", "The map.");
    await s.model(ascension).edit("lore/harbor.md", "The harbor.", "The harbor, drafted.");
    await s.model(ascension).edit("atlas/map.md", "The map.", "The map, drafted.");
    expect.soft((await s.writer.delete("lore")).ok, "the folder deleted live").toBe(true);
    expect.soft((await s.writer.delete("atlas/map.md")).ok).toBe(true);
    const newMap = await s.writer.createDocument("atlas/map.md", "A new map.");

    const items = await s.items(ascension);
    expect.soft(itemFor(items, harbor), "deleted live, still the draft's").toMatchObject({
      path: "manuscript://lore/harbor.md",
      conflict: { code: "deleted_live" },
    });
    expect.soft(itemFor(items, map).conflict, "its path taken").toEqual({
      code: "path_taken",
      path: "manuscript://atlas/map.md",
    });
    expect.soft(await s.applyAll(ascension)).toMatchObject({
      status: "applied",
      draftClosed: false,
      items: expect.arrayContaining([
        {
          itemKey: itemFor(items, harbor).itemKey,
          status: "applied",
          notes: [{ code: "restored", path: "manuscript://lore/harbor.md" }],
        },
        {
          itemKey: itemFor(items, map).itemKey,
          status: "held",
          reason: { code: "path_taken", path: "manuscript://atlas/map.md" },
        },
      ]),
    });
    const live = s.view("live");
    expect.soft(await live.idAt("lore/harbor.md"), "restored with its folder").toBe(harbor);
    expect.soft(await live.text("lore/harbor.md")).toContain("The harbor, drafted.");
    expect.soft(await live.idAt("atlas/map.md"), "the new map stays").toBe(newMap);
    expect.soft(await live.locate(map), "the held one stays deleted").toBeNull();
  });
});
