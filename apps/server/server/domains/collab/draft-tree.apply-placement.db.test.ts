/** Consolidated test contracts; each block retains its original fixture scope. */

import type { DocumentId } from "@meridian/contracts";
import { folders, linkAheadRefs } from "@meridian/database/schema";
import {
  acknowledgeResourceTerminalCleanup,
  applyCatalogChanges,
  type CatalogCacheView,
  catalogViewFromSnapshot,
  publishResourceTerminal,
} from "@meridian/resource-replica";
import { ReplicaHarness } from "@meridian/resource-replica/test-support";
import { and, eq, sql } from "drizzle-orm";
import { describe as __mergedSuite, expect, it } from "vitest";
import { typeLink } from "../../test-support/draft-tree-commands.js";
import { itemFor, type ScenarioWork } from "../../test-support/draft-tree-scenario.js";
import { describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { createDrizzleContextCatalog } from "../context/adapters/context-catalog.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

__mergedSuite("draft-tree.apply-placement.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-tree.apply-placement.db.test.ts.
  describeDraftTreeDb("Apply's tree work (postgres)", (start, db) => {
    it("merges a create the writer also made live, keeps a live rename, and refuses the model's later create usefully (E-1)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const kael = await s.model(ascension).create("characters/kael", "Kael guards the gate.");
      // F26: absent and another view's hidden folder give the same refusal.
      const beacon = await s.work("Beacon", "draft");
      const missing = await s.model(beacon).now("ls", { path: "manuscript://missing/" });
      const hiddenFolder = await s.model(beacon).now("ls", { path: "manuscript://characters/" });
      const refusal = (answer: typeof missing, path: string) =>
        JSON.stringify(answer, (key, value) =>
          key === "toolCallId" ? "<tool-call>" : value,
        ).replaceAll(path, "manuscript://<path>");
      expect
        .soft(refusal(hiddenFolder, "manuscript://characters"))
        .toEqual(refusal(missing, "manuscript://missing"));
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
      // for the draft's view, its links and Apply (S6).
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
      expect.soft(await s.applyAll(ascension), "one command, one publication").toEqual({
        status: "completed",
        draftId: reviewed.draftId,
        items: [{ itemKey: reviewed.itemKey, status: "applied", notes: [] }],
      });
      const live = s.view("live");
      expect.soft(await live.idAt("characters/kael-fix"), "the rename stands").toBe(kael);
      expect.soft(await live.idAt("characters/kael"), "not named back").toBeNull();
      const text = await live.text("characters/kael-fix");
      expect.soft(text, "the draft's text").toContain("Kael guards the gate.");
      expect.soft(text, "the writer's live edit").toContain("The writer's second line.");
      expect.soft(await s.draftStatuses(ascension), "Apply never closes D").toEqual(["active"]);
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
    it("shows a second draft only its own part after the first applies their shared create (E-2)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const kael = await s.model(ascension).create("characters/kael", "Ascension's Kael.");
      const joined = await s.model(beacon).create("characters/kael", "Beacon's Kael.");
      expect.soft(joined, "both drafts use one hidden document").toBe(kael);
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
    it("applies at the right path after a live folder rename absorbed the draft's hidden folder, and a recovered reveal replays from the catalog (E-4)", async () => {
      const { runtime, s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const notes = await s.model(ascension).create("ideas/kael/notes", "Notes.");
      const plan = await s.writer.createDocument("drafts/plan", "Plan.");
      expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });
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
            draftId: item?.draftId,
            itemKey: item?.itemKey,
            item: { itemKey: item?.itemKey, status: "applied", notes: [] },
          },
        },
      ]);
      const live = s.view("live");
      expect.soft(await live.idAt("ideas/kael/notes"), "at the draft's path").toBe(notes);
      expect.soft(await live.idAt("ideas/plan"), "the renamed folder's file").toBe(plan);
      const ideas = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.name, "ideas"), sql`${folders.deletedAt} IS NULL`));
      expect.soft(ideas, "one live ideas folder").toHaveLength(1);
      // A reveal that recovery publishes reaches the catalog's delta stream: a replica
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
    it("restores an edited document deleted live with its folder, and holds one whose path a new document took (E-8)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const harbor = await s.writer.createDocument("lore/harbor", "The harbor.");
      const map = await s.writer.createDocument("atlas/map", "The map.");
      await s.model(ascension).edit("lore/harbor", "The harbor.", "The harbor, drafted.");
      await s.model(ascension).edit("atlas/map", "The map.", "The map, drafted.");
      expect.soft((await s.writer.delete("lore")).ok, "the folder deleted live").toBe(true);
      expect.soft((await s.writer.delete("atlas/map")).ok).toBe(true);
      const newMap = await s.writer.createDocument("atlas/map", "A new map.");
      const items = await s.items(ascension);
      expect.soft(itemFor(items, harbor), "deleted live, still the draft's").toMatchObject({
        contextLocation: { scheme: "manuscript", path: "/lore/harbor" },
        conflict: { code: "deleted_live" },
      });
      expect.soft(itemFor(items, map).conflict, "its path taken").toEqual({
        code: "path_taken",
        path: "manuscript://atlas/map",
      });
      expect.soft(await s.applyAll(ascension)).toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          {
            itemKey: itemFor(items, harbor).itemKey,
            status: "applied",
            notes: [{ code: "restored", path: "manuscript://lore/harbor" }],
          },
          {
            itemKey: itemFor(items, map).itemKey,
            status: "held",
            reason: { code: "path_taken", path: "manuscript://atlas/map" },
          },
        ]),
      });
      const live = s.view("live");
      expect.soft(await live.idAt("lore/harbor"), "restored with its folder").toBe(harbor);
      expect.soft(await live.text("lore/harbor")).toContain("The harbor, drafted.");
      expect.soft(await live.idAt("atlas/map"), "the new map stays").toBe(newMap);
      expect.soft(await live.locate(map), "the held one stays deleted").toBeNull();
    });
    it("projects the restore on the device that deleted the folder, from the server's own receipt, catalog and availability (E-8, F23)", async () => {
      const { runtime, s } = await start();
      const { contextCatalog, projectContextAvailability } = runtime.ports;
      const scope = { kind: "project" as const, projectId: s.project.id };
      const ascension = await s.work("Ascension", "draft");
      const harbor = await s.writer.createDocument("lore/harbor", "The harbor.");
      await s.model(ascension).edit("lore/harbor", "The harbor.", "The harbor, drafted.");
      const device = new ReplicaHarness(s.project.id);
      const beforeDeletion = await contextCatalog.snapshot(scope);
      device.install(beforeDeletion);
      const parent = device.document(harbor).resource.canonicalParent;
      if (parent?.kind !== "folder") throw new Error("harbor should sit in the lore folder");
      const lore = parent.folderId;
      expect(device.projection().ids).toEqual(expect.arrayContaining([lore, harbor]));
      const request = device.requestFolderDeletion(lore);
      expect((await s.writer.delete("lore", request.body.operationId)).ok).toBe(true);
      const receipt = await s.writer.operation(request.body.operationId);
      if (!receipt) throw new Error("the folder delete has no receipt");
      device.settleFolderDeletion(lore, receipt);
      expect
        .soft(device.document(harbor).resource.lifecycle.kind, "receipt's exact ids")
        .toBe("terminal");
      device.install(beforeDeletion);
      expect(device.projection().ids, "a page from before the deletion").not.toContain(lore);
      expect(device.projection().ids).not.toContain(harbor);
      expect(await s.applyAll(ascension)).toMatchObject({ status: "completed" });
      device.install(await contextCatalog.snapshot(scope));
      expect(device.projection().ids, "Apply's restore").toEqual(
        expect.arrayContaining([lore, harbor]),
      );
      expect(device.projection().location(harbor)).toMatchObject({
        path: "/lore/harbor",
      });
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
    it("revives an editor-terminal document when Apply restores it, with content reacquired", async () => {
      const { runtime, s } = await start();
      const catalog = runtime.ports.contextCatalog;
      const scope = { kind: "project" as const, projectId: s.project.id };
      const work = await s.work("Restore", "draft");
      const id = await s.writer.createDocument("chapter", "Text");
      await s.model(work).edit("chapter", "Text", "Draft text");
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
      expect(await s.applyAll(work)).toMatchObject({ status: "completed" });
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
});

__mergedSuite("draft-tree.apply-links.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-tree.apply-links.db.test.ts.
  const KAEL = "manuscript://characters/kael";

  describeDraftTreeDb("Ahead links bind once, on a live arrival (postgres)", (start, db) => {
    it("binds a waiting ahead ref once when Apply reveals its target", async () => {
      const { s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const kaelAhead = await s.seedAhead("characters/kael");
      const twelve = await s.writer.createDocument("chapter-twelve", "Twelve.");
      const chapter = { uri: "manuscript://chapter-twelve", id: twelve };
      /** What the ref means in a view (a Work's, or live): the document, "in a draft", or why not. */
      const read = async (view: ScenarioWork | "live", aheadId: string, href: string) => {
        const { answer } = await s.linkAnswer({
          view,
          ref: `ahead:${aheadId}`,
          href,
          baseUri: chapter.uri,
          holderDocumentId: chapter.id,
        });
        return answer.state === "document"
          ? { id: answer.document.id, ...(answer.inDraft ? { inDraft: true } : {}) }
          : answer.state;
      };
      const everywhere = async (aheadId: string, href: string) => ({
        ascension: await read(ascension, aheadId, href),
        beacon: await read(beacon, aheadId, href),
        live: await read("live", aheadId, href),
      });
      const settledTo = async (aheadId: string) =>
        (
          await db
            .select({ id: linkAheadRefs.settledDocumentId })
            .from(linkAheadRefs)
            .where(eq(linkAheadRefs.aheadId, aheadId))
        )[0]?.id ?? null;
      // D creates kael: every view reads D's document in a draft, and nothing is bound.
      const kael = await s.model(ascension).create("characters/kael", "Kael.");
      const inKael = { id: kael, inDraft: true };
      expect(await everywhere(kaelAhead, KAEL)).toEqual({
        ascension: inKael,
        beacon: inKael,
        live: inKael,
      });
      expect(await settledTo(kaelAhead)).toBeNull();
      // ch12 applied before its target: it still reads kael in a draft, nothing bound.
      await s.model(ascension).edit("chapter-twelve", "Twelve.", "Twelve, drafted.");
      await s.writer.editDraft(ascension, twelve, typeLink(KAEL, kaelAhead));
      expect((await s.apply(ascension, [twelve], { tokens: "none" }))[0]?.httpStatus).toBe(200);
      expect(
        await s.liveMeaning({ ref: `ahead:${kaelAhead}`, href: KAEL, holder: chapter }),
      ).toEqual(inKael);
      expect(await settledTo(kaelAhead)).toBeNull();
      // The target applied: the reveal binds it once, and every view reads the live document.
      expect((await s.apply(ascension, [kael], { tokens: "none" }))[0]?.httpStatus).toBe(200);
      expect(await settledTo(kaelAhead)).toBe(kael);
      expect(await everywhere(kaelAhead, KAEL)).toEqual({
        ascension: { id: kael },
        beacon: { id: kael },
        live: { id: kael },
      });
    });
  });
});

__mergedSuite("draft-tree.apply-holds.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-tree.apply-holds.db.test.ts.
  describeDraftTreeDb("Apply all and holds (postgres)", (start) => {
    it("holds the second draft's picture at a path the first's took, a payload-only Apply (E-5)", async () => {
      const { runtime, s } = await start();
      const { ports } = runtime;
      const { id: projectId, userId } = s.project;
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      for (const name of ["chart", "cover"]) {
        const bytes = new Uint8Array([137, 80, 78, 71, name.length]);
        const put = await ports.objectStore.put(`uploads/${projectId}/${name}`, bytes, "image/png");
        if (!put.ok) throw new Error(put.error.message);
        const uploaded = await ports.contextPorts
          .forProject(projectId, userId, new Map())
          .writeBinary(`manuscript://charts/${name}.png`, {
            fileType: "image",
            storageUrl: put.value.storageUrl,
            mimeType: "image/png",
            sizeBytes: bytes.byteLength,
          });
        if (!uploaded.ok) throw new Error(JSON.stringify(uploaded.error));
      }
      await s.model(ascension).copy("charts/chart.png", "art/map.png");
      await s.model(beacon).copy("charts/cover.png", "art/map.png");
      const [first] = await s.items(ascension);
      const [second] = await s.items(beacon);
      expect
        .soft([first?.binary, first?.branchGeneration], "an image has no branch")
        .toEqual([true, null]);
      expect.soft(first?.documentId, "two pictures").not.toBe(second?.documentId);
      expect.soft(await s.applyAll(ascension), "payload-only").toMatchObject({
        status: "completed",
        items: [{ itemKey: first?.itemKey, status: "applied", notes: [] }],
      });
      expect
        .soft(await s.view("live").idAt("art/map.png"), "the first is live")
        .toBe(first?.documentId);
      const beaconPicture = second?.documentId as DocumentId;
      expect.soft(itemFor(await s.items(beacon), beaconPicture).conflict).toEqual({
        code: "path_taken",
        path: "manuscript://art/map.png",
      });
      expect.soft(await s.applyAll(beacon), "the second is held").toMatchObject({
        status: "completed",
        items: [
          {
            itemKey: second?.itemKey,
            status: "held",
            reason: { code: "path_taken", path: "manuscript://art/map.png" },
          },
        ],
      });
      const sign = (view: Parameters<typeof ports.figureAssets.getSignedFigureUrl>[0]["view"]) =>
        ports.figureAssets
          .getSignedFigureUrl({ projectId, assetDocumentId: beaconPicture, view })
          .then((signed) => (signed.ok ? "signed" : signed.error.code));
      expect
        .soft(await sign(await ports.documentSync.drafts.viewForWork(beacon.id)), "D's view")
        .toBe("signed");
      expect.soft(await sign({ kind: "live" }), "never live").toBe("document_not_found");
    });
    // #766 x F11: drafts and live creates share the name codec, and the shared document and
    // folder namespace is claimed in each view, so a hidden node never vetoes a live entry.
    it("names one canonical row across prose spellings and holds a folder-alias clash at Apply", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const rival = await s.work("Rival", "draft");
      const live = s.view("live");
      const kael = await s.model(ascension).create("characters/Kael", "Kael, drafted.");
      expect
        .soft(await s.model(rival).create("characters/Kael.txt", "Kael, the rival's."), "joined")
        .toBe(kael);
      expect.soft(await live.idAt("characters/Kael.md"), "hidden").toBeNull();
      expect
        .soft(
          await s.writer.create("characters/Kael.md"),
          "a live create of any spelling reveals it",
        )
        .toEqual({ status: "created", documentId: kael });
      expect.soft(await live.idAt("characters/Kael"), "one canonical row, live").toBe(kael);
      // A visible folder alias holds the document name in the draft's view as it does live.
      await s.writer.mkdir("lore/Lore.md");
      const refused = await (await s.model(ascension).reply()).call("write", {
        command: "create",
        path: "manuscript://lore/Lore",
        content: "Refused.",
      });
      expect.soft(refused.isError, "a draft can't create under a folder's alias").toBe(true);
      // A hidden document never vetoes the live folder; Apply holds the draft's item instead.
      const map = await s.model(ascension).create("atlas/Map", "Map, drafted.");
      await s.writer.mkdir("atlas/Map.md");
      const items = await s.items(ascension);
      expect.soft(await s.applyAll(ascension), "held at its taken name").toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          {
            itemKey: itemFor(items, map).itemKey,
            status: "held",
            reason: { code: "path_taken", path: "manuscript://atlas/Map" },
          },
        ]),
      });
      expect.soft(await live.idAt("atlas/Map"), "still hidden").toBeNull();
    });
    // Review and Apply share the alias rule: a draft item whose name a folder alias holds is
    // a clash in review, and a live move that brings two hidden aliases together (F11 lets
    // it) holds both items while an unrelated one applies, never a whole-batch stale.
    it("reviews and holds document/folder alias clashes a live folder or move brings about (#766 x F11)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const live = s.view("live");
      const lore = await s.model(ascension).create("Lore", "Lore, drafted.");
      await s.writer.mkdir("Lore.md");
      expect
        .soft(itemFor(await s.items(ascension), lore).conflict, "review sees the alias")
        .toEqual({
          code: "path_taken",
          path: "manuscript://Lore",
        });
      const inner = await s.model(ascension).create("a/Inner", "Inner, drafted.");
      const chapter = await s.model(ascension).create("b/Inner.md/chapter", "Chapter, drafted.");
      const other = await s.model(ascension).create("other", "Other, drafted.");
      await s.writer.mkdir("a");
      expect
        .soft(await s.writer.move("a", "b"), "the live move absorbs hidden b (F11)")
        .toMatchObject({ ok: true });
      const items = await s.items(ascension);
      expect.soft(itemFor(items, inner).conflict, "the document meets folder Inner.md").toEqual({
        code: "path_taken",
        path: "manuscript://b/Inner",
      });
      expect.soft(itemFor(items, chapter).conflict, "its ancestor meets document Inner").toEqual({
        code: "path_taken",
        path: "manuscript://b/Inner.md",
      });
      const held = (documentId: DocumentId, path: string) => ({
        itemKey: itemFor(items, documentId).itemKey,
        status: "held",
        reason: { code: "path_taken", path: `manuscript://${path}` },
      });
      expect.soft(await s.applyAll(ascension), "per-item holds, never stale").toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          held(lore, "Lore"),
          held(inner, "b/Inner"),
          held(chapter, "b/Inner.md"),
          { itemKey: itemFor(items, other).itemKey, status: "applied", notes: [] },
        ]),
      });
      expect.soft(await live.idAt("other"), "the unrelated item applied").toBe(other);
      expect.soft(await live.idAt("b/Inner"), "held: still hidden").toBeNull();
      expect.soft(await live.idAt("b/Inner.md/chapter"), "held: still hidden").toBeNull();
    });
    it("applies all as one command with per-item results, holds a clash and keeps the draft open (E-7a)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const chapter = await s.writer.createDocument("chapter", "Opening.");
      await s.model(ascension).edit("chapter", "Opening.", "Opening, drafted.");
      const kael = await s.model(ascension).create("characters/kael", "Kael.");
      const notes = await s.model(ascension).create("ideas/kael/notes", "Notes.");
      await s.writer.createDocument("drafts/kael", "A file named kael.");
      expect.soft(await s.writer.move("drafts", "ideas")).toMatchObject({ ok: true });
      const items = await s.items(ascension);
      const keyOf = (documentId: DocumentId) => itemFor(items, documentId).itemKey;
      expect.soft(await s.applyAll(ascension), "per-item results").toEqual({
        status: "completed",
        draftId: items[0]?.draftId,
        items: expect.arrayContaining([
          { itemKey: keyOf(chapter), status: "applied", notes: [] },
          { itemKey: keyOf(kael), status: "applied", notes: [] },
          {
            itemKey: keyOf(notes),
            status: "held",
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        ]),
      });
      const live = s.view("live");
      expect.soft(await live.text("chapter")).toContain("Opening, drafted.");
      expect.soft(await live.idAt("characters/kael")).toBe(kael);
      expect.soft(await live.idAt("ideas/kael/notes"), "held: still hidden").toBeNull();
      expect.soft(await s.draftStatuses(ascension), "a held item keeps D open").toEqual(["active"]);
      expect.soft(await s.apply(ascension, [notes]), "the Apply of a held item").toEqual([
        {
          httpStatus: 409,
          body: {
            status: "held",
            draftId: itemFor(items, notes).draftId,
            itemKey: itemFor(items, notes).itemKey,
            reason: { code: "path_taken", path: "manuscript://ideas/kael" },
          },
        },
      ]);
      expect.soft(await s.writer.move("ideas/kael", "ideas/kael-file")).toMatchObject({ ok: true });
      expect.soft(await s.applyAll(ascension), "drained: D stays open (§2.4)").toMatchObject({
        status: "completed",
        items: [{ itemKey: keyOf(notes), status: "applied" }],
      });
      expect.soft(await s.draftStatuses(ascension)).toEqual(["active"]);
    });
    it("finishes an Apply whose draft grows mid-flight in the same request, (E-7b)", async () => {
      const { s } = await start();
      const beacon = await s.work("Beacon", "draft");
      const second = await s.thread(beacon);
      const live = s.view("live");
      /** At staging, a second chat of the Work adds a document to the draft (F22). */
      const growAtStaging = (path: string) => {
        const remove = setCollabHook("applyItems.afterStaging", async () => {
          remove();
          await s.model(second).create(path, "Late, drafted.");
        });
        return remove;
      };
      const original = await s.model(beacon).create("growth/original", "Original, drafted.");
      const [rendered] = await s.items(beacon);
      const stop = growAtStaging("growth/late");
      const grown = await s.applyAll(beacon);
      stop();
      expect.soft(grown, "the staged batch finishes with real results").toEqual({
        status: "completed",
        draftId: rendered?.draftId,
        items: [{ itemKey: rendered?.itemKey, status: "applied", notes: [] }],
      });
      expect.soft(await live.idAt("growth/original"), "published").toBe(original);
      expect.soft(await live.idAt("growth/late"), "the late item stays in D").toBeNull();
      expect.soft(await s.batchStates(), "one batch, completed").toEqual(["completed"]);
    });
  });
});
