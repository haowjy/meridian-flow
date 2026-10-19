/**
 * Apply's tree work (contract §11.2, ledger E-1, E-2, E-4, E-8): a create the writer also
 * made live merges and a live rename stands, a second branch sees only its part of a
 * shared create, a create applies at its path after a live folder rename absorbed its
 * hidden folder, and a document deleted live is restored with its folder unless another
 * document took its path. Driven through the review route cores. The device that deleted the
 * folder sees the restore: its replica installs the real receipt, catalog and availability.
 * A document the editor terminalized from exact-ID deletion holds that deletion's version: a
 * historical replay page cannot revive it, and a later Apply still does.
 */
import { folders } from "@meridian/database/schema";
import {
  acknowledgeResourceTerminalCleanup,
  applyCatalogChanges,
  type CatalogCacheView,
  catalogViewFromSnapshot,
  publishResourceTerminal,
} from "@meridian/resource-replica";
import { ReplicaHarness } from "@meridian/resource-replica/test-support";
import { and, eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { itemFor } from "../../test-support/branch-tree-scenario.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

describeBranchTreeDb("Apply's tree work (postgres)", (start, db) => {
  it("merges a create the writer also made live, keeps a live rename, and refuses the model's later create usefully (E-1)", async () => {
    const { s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const kael = await s.model(ascension).create("characters/kael", "Kael guards the gate.");
    // F26: absent and another view's hidden folder give the same refusal.
    const beacon = await s.work("Beacon", "draft");
    const missing = await s.model(beacon).now("ls", { path: "manuscript://missing/" });
    const hiddenFolder = await s.model(beacon).now("ls", { path: "manuscript://characters/" });
    for (const answer of [missing, hiddenFolder]) {
      expect.soft(answer.isError).toBe(true);
      expect.soft(answer.result).toMatchObject({ code: "not_found" });
      expect.soft(answer.output).toContain("No folder at manuscript://");
      expect.soft(answer.output).toContain("Writing a file under this path creates the folder.");
    }
    expect
      .soft((await s.model(ascension).now("ls", { path: "kb://" })).output)
      .toBe("kb://\n  (empty)");
    await s.writer.mkdir("empty");
    expect
      .soft((await s.model(beacon).now("ls", { path: "manuscript://empty/" })).output)
      .toBe("manuscript://empty/\n  (empty)");
    const hidden = await s.review(ascension);
    expect.soft(itemFor(hidden.items, kael), "new while hidden").toMatchObject({
      origin: "created",
      isNew: true,
      contextLocation: { scheme: "manuscript", path: "/characters/kael" },
      conflict: null,
    });

    // The writer makes it live: one document, D's own.
    const made = await s.writer.create("characters/kael", { content: "Writer's Kael." });
    expect.soft(made, "the live create reveals D's document").toEqual({
      status: "created",
      documentId: kael,
    });
    // After the reveal it is an existing file: the model's create is refused, with guidance.
    const refused = await s.model(ascension).now("write", {
      command: "create",
      path: "manuscript://characters/kael",
      content: "A second Kael.",
    });
    expect
      .soft(JSON.stringify(refused.output), "create after reveal")
      .toContain("Read it, then edit it");

    // The writer renames it live: the document's place is its row, so the rename stands
    // for the branch's view, its links and Apply (S6).
    expect
      .soft(await s.writer.move("characters/kael", "characters/kael-fix"))
      .toMatchObject({ ok: true });
    await s.writer.write("characters/kael-fix", "Writer's Kael.\n\nThe writer's second line.");
    const reviewed = itemFor(await s.items(ascension), kael);
    expect.soft(reviewed, "revealed, then renamed live").toMatchObject({
      isNew: false,
      contextLocation: { scheme: "manuscript", path: "/characters/kael-fix" },
      conflict: null,
    });
    expect.soft(await s.applyAll(ascension), "one command, one Apply").toEqual({
      status: "completed",
      branchId: reviewed.branchId,
      items: [{ itemKey: reviewed.itemKey, status: "applied", notes: [] }],
    });
    const live = s.view("live");
    expect.soft(await live.idAt("characters/kael-fix"), "the rename stands").toBe(kael);
    expect.soft(await live.idAt("characters/kael"), "not named back").toBeNull();
    const text = await live.text("characters/kael-fix");
    expect.soft(text, "the draft's text").toContain("Kael guards the gate.");
    expect.soft(text, "the writer's live edit").toContain("The writer's second line.");
    expect.soft(await s.branchStatuses(ascension), "Apply never closes D").toEqual(["active"]);

    // A rename that lands after a tokenless Apply read the draft stands too, with no note.
    const notes = await s.model(ascension).create("notes/original", "Notes, drafted.");
    await s.writer.create("notes/original", { content: "Writer's notes." });
    const renameLate = setCollabHook("applyItems.beforeStaging", async () => {
      renameLate();
      await s.writer.move("notes/original", "notes/renamed");
    });
    const [raced] = await s.apply(ascension, [notes], { tokens: "none" });
    renameLate();
    expect.soft(raced, "the raced rename stands").toMatchObject({
      httpStatus: 200,
      body: { item: { status: "applied", notes: [] } },
    });
    expect.soft(await live.idAt("notes/renamed")).toBe(notes);
    expect.soft(await live.idAt("notes/original")).toBeNull();
  });

  it("shows a second branch only its own part after the first applies their shared create (E-2)", async () => {
    const { runtime, s } = await start();
    const [ascension, beacon] = [
      await s.work("Ascension", "draft"),
      await s.work("Beacon", "draft"),
    ];
    const kael = await s.model(ascension).create("characters/kael", "Ascension's Kael.");
    const joined = await s.model(beacon).create("characters/kael", "Beacon's Kael.");
    expect.soft(joined, "both branches use one hidden document").toBe(kael);

    expect.soft((await s.applyAll(ascension)).status).toBe("completed");
    expect.soft(await s.view("live").text("characters/kael")).toContain("Ascension's Kael.");
    const [item] = await s.items(beacon);
    expect.soft(item, "Beacon still has it, no longer new").toMatchObject({
      documentId: kael,
      origin: "created",
      isNew: false,
      conflict: null,
    });
    const preview = await runtime.ports.documentSync.draftReview.preview({
      workId: beacon.id,
      itemKey: item?.itemKey ?? "",
    });
    if (preview.status !== "active") throw new Error("Beacon's review is gone");
    const excerpts = preview.operations.map((operation) => operation.afterExcerpt ?? "");
    expect.soft(excerpts.join(" "), "Beacon's part").toContain("Beacon's Kael.");
    expect.soft(excerpts.join(" "), "never Ascension's").not.toContain("Ascension's Kael.");
    expect.soft(preview.item.isNew, "the preview's item").toBe(false);
  });

  it("applies at the right path after a live folder rename absorbed the branch's hidden folder, and a recovered reveal replays from the catalog (E-4)", async () => {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const notes = await s.model(ascension).create("ideas/kael/notes", "Notes.");
    const plan = await s.writer.createDocument("branches/plan", "Plan.");
    expect.soft(await s.writer.move("branches", "ideas")).toMatchObject({ ok: true });
    const [item] = await s.items(ascension);
    expect.soft(item, "still new, at its path").toMatchObject({
      documentId: notes,
      isNew: true,
      contextLocation: { scheme: "manuscript", path: "/ideas/kael/notes" },
      conflict: null,
    });
    // The legacy per-document Apply of a hidden create (early probe 2: it answered 404).
    expect.soft(await s.apply(ascension, [notes], { tokens: "none" })).toMatchObject([
      {
        httpStatus: 200,
        body: {
          status: "applied",
          branchId: item?.branchId,
          itemKey: item?.itemKey,
          item: { itemKey: item?.itemKey, status: "applied", notes: [] },
        },
      },
    ]);
    const live = s.view("live");
    expect.soft(await live.idAt("ideas/kael/notes"), "at its path in the branch").toBe(notes);
    expect.soft(await live.idAt("ideas/plan"), "the renamed folder's file").toBe(plan);
    const ideas = await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.name, "ideas"), sql`${folders.deletedAt} IS NULL`));
    expect.soft(ideas, "one live ideas folder").toHaveLength(1);

    // A reveal that recovery applies reaches the catalog's delta stream: a replica
    // replaying from a cursor taken before the Apply learns of the file (F23, E-R4).
    const { contextCatalog } = runtime.ports;
    const scope = { kind: "project" as const, projectId: s.project.id };
    const fresh = await s.model(ascension).create("catalog/new", "Drafted catalog file.");
    const before = await contextCatalog.snapshot(scope);
    const remove = setCollabHook("applyItems.afterStaging", async () => {
      remove();
      throw new Error("injected process death after staging");
    });
    await expect(s.applyAll(ascension)).rejects.toThrow("process death");
    await s.expirePendingClaims();
    await expect(s.recover()).resolves.toBe(1);
    const replayed = await contextCatalog.changes(scope, before.cursor);
    expect
      .soft(JSON.stringify(replayed), "the file replays from the pre-Apply cursor")
      .toContain(fresh);
  });

  /** The editor's exact-ID terminal, as the device's session coordinator publishes it. */
  async function editorTerminal(
    runtime: Awaited<ReturnType<typeof start>>["runtime"],
    s: Awaited<ReturnType<typeof start>>["s"],
    device: ReplicaHarness,
    documentId: string,
  ) {
    const lookup = await runtime.ports.projectContextAvailability.lookup(
      { projectId: s.project.id, documentIds: [documentId] },
      { userId: s.project.userId },
    );
    const deleted = lookup.resolutions[0];
    if (deleted?.kind !== "deleted") throw new Error("the document should be deleted");
    const terminal = {
      documentId,
      generation: deleted.generation,
      transitionId: "editor-purge",
      exactDatabaseName: "editor-copy",
      deletionVersion: deleted.observationVersion,
    };
    device.document(documentId).resource.content = {
      kind: "exact",
      databaseName: "editor-copy",
      schema: null,
    };
    for (const plan of [publishResourceTerminal, acknowledgeResourceTerminalCleanup]) {
      const write = plan({ record: device.document(documentId), ...terminal });
      if (!write) throw new Error("the editor terminal should commit");
      device.commitResource(write);
    }
    return deleted;
  }

  function installView(device: ReplicaHarness, view: CatalogCacheView) {
    device.install({
      scope: view.scope,
      generation: view.generation,
      headRevision: view.appliedRevision,
      cursor: view.cursor,
      entries: [...view.entries.values()],
    });
  }

  it("keeps an editor-terminal document deleted through a default-sized replay page from before its deletion", async () => {
    const { runtime, s } = await start();
    const catalog = runtime.ports.contextCatalog;
    const scope = { kind: "project" as const, projectId: s.project.id };
    const id = await s.writer.createDocument("old", "Text");
    const before = await catalog.snapshot(scope);
    const device = new ReplicaHarness(s.project.id);
    device.install(before);

    // A full first page (the default 100 commits) of pre-deletion history, then the delete.
    expect((await s.writer.move("old", "moved")).ok).toBe(true);
    const publisher = createDrizzleContextCatalog(db);
    for (let n = 0; n < 99; n++)
      await publisher.refreshSources([s.project.sources.manuscript], [id]);
    expect((await s.writer.delete("moved")).ok).toBe(true);
    await editorTerminal(runtime, s, device, id);

    // The acquisition starts after the terminal transition, from the old cursor.
    const first = await catalog.changes(scope, before.cursor);
    if (first.kind !== "delta") throw new Error("expected a replay delta");
    expect(first.hasMore, "the deletion sits on a later page").toBe(true);
    const moved = [...first.commits]
      .flatMap((commit) => commit.changes)
      .some((change) => change.operation === "upsert" && change.entry.entryId === id);
    expect(moved, "the first page shows the document present").toBe(true);
    let view = applyCatalogChanges(catalogViewFromSnapshot(before), first);
    if (!view) throw new Error("the first page should apply");
    installView(device, view);
    expect.soft(device.document(id).resource.lifecycle.kind, "historical page").toBe("terminal");
    expect.soft(device.projection().ids).not.toContain(id);

    const rest = await catalog.changes(scope, view.cursor);
    view = applyCatalogChanges(view, rest);
    if (!view) throw new Error("the deletion page should apply");
    installView(device, view);
    expect(device.document(id).resource.lifecycle.kind, "after draining").toBe("terminal");
    expect(device.projection().location(id)).toBeNull();
  });
});
