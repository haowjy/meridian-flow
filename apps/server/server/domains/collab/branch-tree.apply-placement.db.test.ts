import {
  acknowledgeResourceTerminalCleanup,
  applyCatalogChanges,
  type CatalogCacheView,
  catalogViewFromSnapshot,
  publishResourceTerminal,
} from "@meridian/resource-replica";
import { ReplicaHarness } from "@meridian/resource-replica/test-support";
import { expect, it } from "vitest";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";

describeBranchTreeDb("Apply's tree work (postgres)", (start, db) => {
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
