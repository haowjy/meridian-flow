import type { DocumentId } from "@meridian/contracts";
import { documents } from "@meridian/database/schema";
import {
  acknowledgeResourceTerminalCleanup,
  applyCatalogChanges,
  type CatalogCacheView,
  catalogViewFromSnapshot,
  publishResourceTerminal,
} from "@meridian/resource-replica";
import { ReplicaHarness } from "@meridian/resource-replica/test-support";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { runInRootDrizzleTransaction } from "../../shared/drizzle-transaction.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { acquireTreeScope } from "../context/tree/mutation-scope.js";
import { type RemovalIdentity, restoreDocument } from "../context/tree/removal.js";

describeBranchTreeDb("Apply's tree work (postgres)", (start, db) => {
  /** The restore Apply runs for a deleted document, in a transaction of its own (D79). */
  async function restore(
    runtime: Awaited<ReturnType<typeof start>>["runtime"],
    documentId: DocumentId,
    removal?: RemovalIdentity,
  ) {
    return runInRootDrizzleTransaction(db, async () => {
      await acquireTreeScope(db, { documentIds: [documentId] });
      return restoreDocument(
        db,
        { documentId, ...(removal ? { removal } : {}) },
        { catalog: runtime.ports.contextCatalog },
      );
    });
  }

  it("restores deleted documents with their folders, counts past a new occupant, and never undoes a later removal (E-8)", async () => {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const harbor = await s.writer.createDocument("lore/harbor", "The harbor.");
    const map = await s.writer.createDocument("atlas/map", "The map.");
    await s.model(ascension).edit("lore/harbor", "The harbor.", "The harbor, drafted.");
    expect((await s.writer.delete("lore")).ok, "the folder deleted live").toBe(true);
    expect((await s.writer.delete("atlas/map")).ok).toBe(true);
    const newMap = await s.writer.createDocument("atlas/map", "A new map.");
    const [first] = await db
      .select({ time: documents.deletedAt, locationVersion: documents.locationVersion })
      .from(documents)
      .where(eq(documents.id, harbor));
    if (!first?.time) throw new Error("harbor should be deleted");
    const reversing = { time: first.time, locationVersion: first.locationVersion };

    expect
      .soft(
        await restore(runtime, harbor, {
          ...reversing,
          locationVersion: reversing.locationVersion - 1n,
        }),
        "another removal than the one reversed",
      )
      .toEqual({ kind: "superseded" });
    expect.soft(await restore(runtime, harbor, reversing)).toMatchObject({ kind: "restored" });
    const live = s.view("live");
    expect.soft(await live.idAt("lore/harbor"), "restored with its folder").toBe(harbor);
    expect
      .soft(await live.text("lore/harbor"), "live keeps its last text")
      .toContain("The harbor.");
    expect.soft(await s.view(ascension).text("lore/harbor")).toContain("The harbor, drafted.");
    expect.soft(await restore(runtime, harbor)).toEqual({ kind: "already_living" });

    expect.soft(await restore(runtime, map)).toMatchObject({ kind: "restored" });
    expect.soft(await live.idAt("atlas/map"), "the new map stays").toBe(newMap);
    expect.soft(await live.idAt("atlas/map (2)"), "the restored map lands beside it").toBe(map);
  });

  it("projects the restore on the device that deleted the folder, from the server's own receipt, catalog and availability (E-8, F23)", async () => {
    const { runtime, s } = await start();
    const { contextCatalog, projectContextAvailability } = runtime.ports;
    const scope = { kind: "project" as const, projectId: s.project.id };
    const harbor = await s.writer.createDocument("lore/harbor", "The harbor.");

    const device = new ReplicaHarness(s.project.id);
    const beforeDeletion = await contextCatalog.snapshot(scope);
    device.install(beforeDeletion);
    const parent = device.document(harbor).resource.canonicalParent;
    if (parent?.kind !== "folder") throw new Error("harbor should sit in the lore folder");
    const lore = parent.folderId;

    const request = device.requestFolderDeletion(lore);
    expect((await s.writer.delete("lore", request.body.operationId)).ok).toBe(true);
    const receipt = await s.writer.operation(request.body.operationId);
    if (!receipt) throw new Error("the folder delete has no receipt");
    device.settleFolderDeletion(lore, receipt);
    expect
      .soft(device.document(harbor).resource.lifecycle.kind, "receipt's exact ids")
      .toBe("terminal");

    expect(await restore(runtime, harbor)).toMatchObject({ kind: "restored" });
    device.install(await contextCatalog.snapshot(scope));
    expect(device.projection().ids, "the restore").toEqual(expect.arrayContaining([lore, harbor]));
    expect(device.projection().location(harbor)).toMatchObject({ path: "/lore/harbor" });
    expect(device.folder(lore).terminal).toBeUndefined();

    // Exact-ID availability reports both present, strictly newer than the deletion.
    const availability = await projectContextAvailability.lookup(
      { projectId: s.project.id, documentIds: [harbor], folderIds: [lore] },
      { userId: s.project.userId },
    );
    const folder = availability.folderResolutions?.[0];
    const document = availability.resolutions[0];
    if (folder?.kind !== "available" || document?.kind !== "available")
      throw new Error(`restored identities should be available: ${JSON.stringify(availability)}`);
    for (const version of [folder.entry.observationVersion, document.entry.observationVersion])
      expect(BigInt(version) > BigInt(receipt.observationVersion)).toBe(true);
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

  it("revives an editor-terminal document when it is restored, with content reacquired", async () => {
    const { runtime, s } = await start();
    const catalog = runtime.ports.contextCatalog;
    const scope = { kind: "project" as const, projectId: s.project.id };
    const id = await s.writer.createDocument("chapter", "Text");
    const before = await catalog.snapshot(scope);
    const device = new ReplicaHarness(s.project.id);
    device.install(before);

    expect((await s.writer.delete("chapter")).ok).toBe(true);
    const deleted = await editorTerminal(runtime, s, device, id);
    const caughtUp = applyCatalogChanges(
      catalogViewFromSnapshot(before),
      await catalog.changes(scope, before.cursor),
    );
    if (!caughtUp) throw new Error("the deletion should apply");
    installView(device, caughtUp);
    expect(device.document(id).resource.lifecycle.kind).toBe("terminal");

    expect(await restore(runtime, id)).toMatchObject({ kind: "restored" });
    device.install(await catalog.snapshot(scope));
    const restored = device.document(id).resource;
    expect(restored.lifecycle.kind).toBe("acknowledged");
    expect(restored.content.kind).toBe("unacquired");
    expect(BigInt(restored.observationVersion ?? "0") > BigInt(deleted.observationVersion)).toBe(
      true,
    );
    expect(device.projection().location(id)).toMatchObject({ path: "/chapter" });
  });
});
