/**
 * Discard and purge leave nothing live and release storage (contract §12, §2.6, ledger
 * D-1 to D-3): a hidden document drafts share stays while any of them uses it, and the
 * last one's Discard tombstones it and its hidden folders, releasing its live Yjs, every
 * branch on it and a picture's bytes, while links that named it read gone and capture
 * nothing; two drafts discarding it at once leave one tombstone; a purged Work's drafts go
 * through the locked kernel, never the active-Work command. And a read that meets a
 * hidden node no draft uses repairs it (§12.4).
 */
import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  documentBranches,
  documentMarkdownProjections,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  draftTreeChanges,
  folders,
  linkAheadDraftSettlements,
  linkAheadRefs,
  users,
  works,
} from "@meridian/database/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { handleDocumentLinkResolveRequest } from "../../lib/document-link-route.js";
import {
  currentDrizzleDb,
  runOutsideDrizzleTransaction,
} from "../../shared/drizzle-transaction.js";
import { useComposedRuntimes } from "../../test-support/composed-runtime.js";
import { typeLink } from "../../test-support/draft-tree-commands.js";
import {
  type DraftTreeScenario,
  draftTreeScenario,
  type ScenarioRuntime,
} from "../../test-support/draft-tree-scenario.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { setTreeHook } from "../context/tree/test-hooks.js";
import { createInMemoryEventSink } from "../observability/index.js";
import { processDetachedWork } from "../runtime/detached-work.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("Discard and purge (postgres)", () => {});
} else {
  describe("Discard and purge (postgres)", () => {
    // Discards race on several connections and purge commits: this suite commits.
    const db = createDb(DATABASE_URL, { max: 12 });
    afterAll(() => db.close());
    const runtimes = useComposedRuntimes(() => db);

    beforeEach(async () => {
      await deleteDrizzleRows(db, [users]);
    });

    async function start(options: Parameters<typeof runtimes.compose>[0] = {}) {
      const runtime = await runtimes.compose(options);
      return { runtime, s: await draftTreeScenario(db, { runtime, runtimes }) };
    }

    /** A live picture the writer uploaded at `path`. */
    async function livePicture(runtime: ScenarioRuntime, s: DraftTreeScenario, path: string) {
      const { id: projectId, userId } = s.project;
      const bytes = new Uint8Array([137, 80, 78, 71, path.length]);
      const put = await runtime.ports.objectStore.put(
        `uploads/${projectId}/${path}`,
        bytes,
        "image/png",
      );
      if (!put.ok) throw new Error(put.error.message);
      const uploaded = await runtime.ports.contextPorts
        .forProject(projectId, userId, new Map())
        .writeBinary(`manuscript://${path}`, {
          fileType: "image",
          storageUrl: put.value.storageUrl,
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        });
      if (!uploaded.ok) throw new Error(JSON.stringify(uploaded.error));
    }

    /** The document row's lifecycle: hidden, tombstoned, and its location version. */
    async function row(id: DocumentId) {
      const [found] = await db
        .select({
          hidden: documents.hidden,
          deletedAt: documents.deletedAt,
          version: documents.locationVersion,
        })
        .from(documents)
        .where(eq(documents.id, id));
      return found
        ? { hidden: found.hidden, tombstone: found.deletedAt !== null, version: found.version }
        : null;
    }

    /** What storage the document still holds (R8): live Yjs rows, branches, its projection. */
    async function storageOf(id: DocumentId) {
      const count = async (rows: Promise<unknown[]>) => (await rows).length;
      return {
        yjs:
          (await count(
            db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, id)),
          )) +
          (await count(
            db
              .select()
              .from(documentYjsCheckpoints)
              .where(eq(documentYjsCheckpoints.documentId, id)),
          )) +
          (await count(
            db.select().from(documentYjsHeads).where(eq(documentYjsHeads.documentId, id)),
          )),
        branches: await count(
          db.select().from(documentBranches).where(eq(documentBranches.documentId, id)),
        ),
        projection: await count(
          db
            .select()
            .from(documentMarkdownProjections)
            .where(eq(documentMarkdownProjections.documentId, id)),
        ),
      };
    }

    /** Folders named `name` in the project that aren't tombstones, hidden ones included. */
    async function foldersNamed(s: DraftTreeScenario, name: string) {
      return db
        .select({ id: folders.id })
        .from(folders)
        .where(
          and(
            eq(folders.name, name),
            isNull(folders.deletedAt),
            inArray(folders.contextSourceId, Object.values(s.project.sources)),
          ),
        );
    }

    async function rowsNaming(id: DocumentId) {
      return db
        .select({ draftId: draftTreeChanges.draftId })
        .from(draftTreeChanges)
        .where(eq(draftTreeChanges.nodeId, id));
    }

    async function objectAt(runtime: ScenarioRuntime, documentId: DocumentId) {
      const [found] = await db
        .select({ storageUrl: documents.storageUrl })
        .from(documents)
        .where(eq(documents.id, documentId));
      const key = found?.storageUrl?.replace(/^object:\/\/meridian\//, "") ?? "";
      const got = await runtime.ports.objectStore.get(key);
      return got.ok ? "stored" : got.error.code;
    }

    it("keeps a shared hidden document for the draft still using it, and the last Discard tombstones it, its folders and its storage (D-1)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const ORI = "manuscript://lore/deep/ori";
      // A live ahead ref at the path before any draft creates it: Ascension's create settles it.
      const one = await s.writer.createDocument("chapter-one", "[Ori](lore/deep/ori) waits.");
      const [registered] = await db
        .select({ aheadId: linkAheadRefs.aheadId })
        .from(linkAheadRefs)
        .where(eq(linkAheadRefs.path, "lore/deep/ori"));
      const waiting = registered?.aheadId ?? "";
      const ori = await s.model(ascension).create("lore/deep/ori", "Ascension's Ori.");
      expect
        .soft(await s.model(beacon).create("lore/deep/ori", "Beacon's Ori."), "joined")
        .toBe(ori);
      expect
        .soft(
          await db
            .select({ documentId: linkAheadDraftSettlements.documentId })
            .from(linkAheadDraftSettlements)
            .where(eq(linkAheadDraftSettlements.aheadId, waiting)),
          "the live ref settles in the drafts that made Ori",
        )
        .toContainEqual({ documentId: ori });
      // A live holder bound to Ori: chapter two, edited in Beacon, applied alone.
      const two = await s.writer.createDocument("chapter-two", "Two.");
      await s.model(beacon).edit("chapter-two", "Two.", "Two, drafted.");
      const bound = crypto.randomUUID();
      await s.writer.editDraft(beacon, two, typeLink(ORI, bound));
      expect.soft((await s.apply(beacon, [two], { tokens: "none" }))[0]?.httpStatus).toBe(200);
      const chapterTwo = { uri: "manuscript://chapter-two", id: two };
      const chapterOne = { uri: "manuscript://chapter-one", id: one };
      expect
        .soft(
          await s.liveMeaning({ ref: `ahead:${bound}`, href: ORI, holder: chapterTwo }),
          "bound, in a draft",
        )
        .toEqual({ id: ori, inDraft: true, bound: true });
      // A picture of Beacon's own, with its own bytes (12b-Q2).
      await livePicture(runtime, s, "charts/chart.png");
      await s.model(beacon).copy("charts/chart.png", "lore/map.png");
      const map = (await s.review(beacon)).items.find((item) => item.binary)
        ?.documentId as DocumentId;
      expect.soft(await objectAt(runtime, map), "the copy's own bytes").toBe("stored");
      const versionBefore = (await row(ori))?.version ?? 0n;

      // Ascension discards Ori: Beacon still uses it, so it stays hidden for Beacon.
      expect
        .soft(await s.discard(ascension, [ori]))
        .toEqual([{ status: "discarded", draftId: expect.any(String) }]);
      expect
        .soft(await row(ori), "kept for Beacon")
        .toMatchObject({ hidden: true, tombstone: false });
      expect
        .soft(await s.view(beacon).read("lore/deep/ori"), "Beacon still reads it")
        .toMatchObject({
          ok: true,
          value: { content: expect.stringContaining("Beacon's Ori.") },
        });
      expect
        .soft(await s.view(ascension).stat("lore/deep/ori"), "gone from Ascension's view")
        .toMatchObject({ ok: false });
      expect
        .soft(await s.draftStatuses(ascension), "an item Discard never closes")
        .toEqual(["active"]);

      // Beacon discards everything: the last use ends, in one command.
      const beaconDraft = (await s.review(beacon)).items[0]?.draftId ?? "";
      expect
        .soft(await s.discard(beacon, "all"), "Discard all")
        .toEqual({ status: "discarded", draftId: beaconDraft, draftClosed: true });
      expect.soft(await s.draftStatuses(beacon), "closed").toEqual(["closed"]);
      expect
        .soft(await row(ori), "tombstoned once, still hidden")
        .toEqual({ hidden: true, tombstone: true, version: versionBefore + 1n });
      expect
        .soft(await storageOf(ori), "its live Yjs, every branch on it, its projection: released")
        .toEqual({ yjs: 0, branches: 0, projection: 0 });
      expect.soft(await rowsNaming(ori), "no draft names it").toEqual([]);
      expect.soft(await foldersNamed(s, "deep"), "its hidden folder, bottom-up").toEqual([]);
      expect.soft(await foldersNamed(s, "lore"), "and the one above").toEqual([]);
      expect.soft(await row(map), "Beacon's picture tombstoned").toMatchObject({ tombstone: true });
      expect.soft(await objectAt(runtime, map), "and its bytes deleted").toBe("not_found");
      expect.soft(await s.view("live").ls(""), "nothing of the drafts is live").toMatchObject({
        ok: true,
        value: expect.not.arrayContaining([expect.objectContaining({ name: "lore" })]),
      });
      expect
        .soft(
          await db
            .select()
            .from(linkAheadDraftSettlements)
            .where(eq(linkAheadDraftSettlements.documentId, ori)),
          "no settlement names it",
        )
        .toEqual([]);
      expect
        .soft(
          await s.liveMeaning({ ref: `ahead:${bound}`, href: ORI, holder: chapterTwo }),
          "the bound link reads gone",
        )
        .toBe("gone");
      expect
        .soft(
          await s.liveMeaning({ ref: `ahead:${waiting}`, href: ORI, holder: chapterOne }),
          "the live ref: Doesn't exist yet",
        )
        .toBe("missing");
      const later = await s.writer.createDocument("lore/deep/ori", "A new Ori.");
      expect.soft(later, "a new live document").not.toBe(ori);
      expect
        .soft(
          await s.liveMeaning({ ref: `ahead:${bound}`, href: ORI, holder: chapterTwo }),
          "which doesn't capture the bound link",
        )
        .toBe("gone");
    });

    it("leaves one tombstone and no orphan when two drafts discard a shared document at once (D-2)", async () => {
      const { s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const ori = await s.model(ascension).create("lore/ori", "Ascension's Ori.");
      expect.soft(await s.model(beacon).create("lore/ori", "Beacon's Ori.")).toBe(ori);
      const versionBefore = (await row(ori))?.version ?? 0n;

      // Ascension holds Ori's locks having seen Beacon's use; Beacon's Discard all waits.
      const run = await interleave(
        db,
        () => s.discard(ascension, [ori]),
        "endUse.afterRevalidate",
        () => s.discard(beacon, "all"),
        { waitMs: 500 },
      );
      expect.soft(run.a, "the item Discard").toMatchObject({ ok: true });
      expect.soft(run.bWaited || run.bBlocked, "the other waits on its locks").toBe(true);
      expect.soft(run.b, "Discard all").toMatchObject({ ok: true, value: { status: "discarded" } });
      expect
        .soft(await row(ori), "one tombstone")
        .toEqual({ hidden: true, tombstone: true, version: versionBefore + 1n });
      expect.soft(await rowsNaming(ori), "no row names it").toEqual([]);
      expect.soft(await storageOf(ori), "released").toEqual({ yjs: 0, branches: 0, projection: 0 });
      expect.soft(await foldersNamed(s, "lore"), "no hidden folder left behind").toEqual([]);
    });

    it("purges a deleted Work's drafts through the kernel, never the public Discard (D-3)", async () => {
      const { runtime, s } = await start();
      const doomed = await s.work("Doomed", "draft");
      const plan = await s.model(doomed).create("notes/plan", "The plan.");
      await livePicture(runtime, s, "charts/chart.png");
      await s.model(doomed).copy("charts/chart.png", "art/map.png");
      const chapter = await s.writer.createDocument("chapter", "Live words.");
      await s.model(doomed).edit("chapter", "Live words.", "Drafted words.");
      const items = (await s.review(doomed)).items;
      const map = items.find((item) => item.binary)?.documentId as DocumentId;
      const draftId = items[0]?.draftId ?? "";
      expect.soft(items.map((item) => item.documentId).sort()).toEqual([plan, map, chapter].sort());

      await runtime.ports.workRepo.softDelete(doomed.id);
      await expect(
        s.discard(doomed, "all", { draftId }),
        "the public command refuses",
      ).rejects.toThrow();
      expect.soft(await s.draftStatuses(doomed), "and left the draft alone").toEqual(["active"]);
      expect.soft(await row(plan), "its create still hidden").toMatchObject({ tombstone: false });

      expect.soft(await s.purge(doomed), "purged").toBe(1);
      expect.soft(await s.draftStatuses(doomed), "its drafts are gone").toEqual([]);
      for (const created of [plan, map]) {
        expect.soft(await row(created), "tombstoned, still hidden").toMatchObject({
          hidden: true,
          tombstone: true,
        });
        expect
          .soft(await storageOf(created), "released")
          .toEqual({ yjs: 0, branches: 0, projection: 0 });
      }
      expect.soft(await objectAt(runtime, map), "the picture's bytes").toBe("not_found");
      expect.soft(await foldersNamed(s, "notes"), "no hidden folder stays").toEqual([]);
      expect.soft(await foldersNamed(s, "art"), "none").toEqual([]);
      expect
        .soft(await storageOf(chapter), "the edited chapter keeps its Yjs, loses the branches")
        .toMatchObject({
          branches: 0,
        });
      expect
        .soft(await s.view("live").read("chapter"), "and its live text")
        .toMatchObject({ ok: true, value: { content: expect.stringContaining("Live words.") } });
    });

    it("repairs a hidden document no draft uses when a read meets it (§12.4)", async () => {
      const eventSink = createInMemoryEventSink();
      const { runtime, s } = await start({ eventSink });
      const drafting = await s.work("Drafting", "draft");
      const stray = await s.model(drafting).create("lore/stray", "Stray.");
      // A bug's leftover: the draft's use is gone, the node is still hidden and live.
      await db.delete(draftTreeChanges).where(eq(draftTreeChanges.nodeId, stray));
      const holder = await s.writer.createDocument("chapter", "Chapter.");
      const resolved = await handleDocumentLinkResolveRequest(
        {
          projectRepo: runtime.app.projectRepo,
          documentLinks: runtime.app.documentLinks,
          linkScopes: runtime.app.linkScopes,
          workAuthorityResolver: runtime.app.workAuthorityResolver,
          fileAccess: runtime.app.fileAccess,
          drafts: runtime.app.documentSync.drafts,
        },
        {
          projectId: s.project.id,
          userId: s.project.userId,
          request: {
            workId: null,
            baseUri: "manuscript://chapter",
            holderDocumentId: holder,
            links: [{ ref: `doc:${stray}`, href: "lore/stray" }],
          },
        },
      );
      expect.soft(resolved.answers[0]?.state, "the read answers gone").toBe("gone");
      // The repair runs after the read, detached and tracked: wait for it to settle.
      expect(await processDetachedWork.drain(5_000), "the repair settles").toBe(true);
      expect.soft(await row(stray), "tombstoned").toMatchObject({ hidden: true, tombstone: true });
      expect
        .soft(await storageOf(stray), "released")
        .toEqual({ yjs: 0, branches: 0, projection: 0 });
      expect.soft(await foldersNamed(s, "lore"), "its hidden folder too").toEqual([]);
      expect
        .soft(
          eventSink.events.filter(
            (event) => event.source === "context.hidden-node" && event.name === "repaired",
          ),
          "one warn event",
        )
        .toMatchObject([{ level: "warn", payload: { documentIds: [stray] } }]);
    });
    it("retires only its own draft's peers: another Work's staged reply on the shared document saves (D-R1)", async () => {
      const { s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const ori = await s.model(ascension).create("lore/ori", "Ascension's Ori.");
      expect.soft(await s.model(beacon).create("lore/ori", "Beacon's Ori."), "joined").toBe(ori);
      const staged = await s.model(beacon).reply();
      expect((await staged.call("read", { path: "manuscript://lore/ori" })).isError).toBeFalsy();
      const write = await staged.call("write", {
        command: "replace",
        path: "manuscript://lore/ori",
        find: "Beacon's Ori.",
        content: "BEACON STAGED TEXT.",
      });
      expect(write.isError, JSON.stringify(write.output)).toBeFalsy();

      await s.discard(ascension, [ori]);
      const saved = (await staged.save()) as {
        status: string;
        receipts: { documentId: string }[];
        refused: unknown[];
      };
      expect.soft(saved.status, "Beacon's reply saves").toBe("committed");
      expect.soft(saved.refused, "refusing nothing").toEqual([]);
      expect
        .soft(
          saved.receipts.map((receipt) => receipt.documentId),
          "with a receipt for Ori",
        )
        .toContain(ori);
      expect
        .soft(await s.view(beacon).read("lore/ori"), "Beacon's staged text survived")
        .toMatchObject({
          ok: true,
          value: { content: expect.stringContaining("BEACON STAGED TEXT.") },
        });
    });

    it("repairs a corrupt draft branch in review without touching another Work's staged reply (corrupt reset)", async () => {
      const { runtime, s } = await start();
      const [ascension, beacon] = [
        await s.work("Ascension", "draft"),
        await s.work("Beacon", "draft"),
      ];
      const chapter = await s.writer.createDocument("chapter", "Live words.");
      await s.model(ascension).edit("chapter", "Live words.", "Ascension's words.");
      await s.model(beacon).edit("chapter", "Live words.", "Beacon's words.");
      const staged = await s.model(beacon).reply();
      expect((await staged.call("read", { path: "manuscript://chapter" })).isError).toBeFalsy();
      const write = await staged.call("write", {
        command: "replace",
        path: "manuscript://chapter",
        find: "Beacon's words.",
        content: "BEACON STAGED TEXT.",
      });
      expect(write.isError, JSON.stringify(write.output)).toBeFalsy();
      // The seam: Ascension's draft branch row no longer decodes.
      const item = (await s.review(ascension)).items.find((each) => each.documentId === chapter);
      const branchId = item?.draftBranchId ?? "";
      await db
        .update(documentBranches)
        .set({ state: Buffer.from([255, 255, 255, 255]) })
        .where(eq(documentBranches.id, branchId));

      const preview = await runtime.ports.documentSync.draftReview.preview({
        workId: ascension.id,
        documentId: chapter,
        draftId: branchId,
      });
      expect.soft(preview, "the review repaired it").toMatchObject({
        status: "active",
        notice: { code: "branch_corrupt_reset" },
      });
      const saved = (await staged.save()) as {
        status: string;
        receipts: { documentId: string }[];
        refused: unknown[];
      };
      expect.soft(saved.refused, "Beacon's reply refuses nothing").toEqual([]);
      expect.soft(saved.receipts.map((receipt) => receipt.documentId)).toContain(chapter);
      expect
        .soft(await s.view(beacon).read("chapter"), "Beacon's staged text survived")
        .toMatchObject({
          ok: true,
          value: { content: expect.stringContaining("BEACON STAGED TEXT.") },
        });
    });

    it("purges only inside a verified scope: a move to another source and a create there leave no hidden document under a tombstone (D-R2)", async () => {
      const { runtime, s } = await start();
      const [doomed, beacon] = [await s.work("Doomed", "draft"), await s.work("Beacon", "draft")];
      await s.writer.mkdir("carry");
      const ori = await s.model(doomed).create("carry/sub/ori", "Text.");
      await runtime.ports.workRepo.softDelete(doomed.id);
      await db
        .update(works)
        .set({ deletedAt: new Date(Date.now() - 32 * 24 * 60 * 60 * 1_000) })
        .where(eq(works.id, doomed.id));

      // At purge's last check, a create of Beacon's under the moved folder starts; paused
      // after its locks, it either already holds what purge needs or waits on purge.
      let created: Promise<unknown> | null = null;
      let reachedCreate = false;
      let releaseCreate!: () => void;
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      const removeCreateHook = setTreeHook("createInDraft.afterCandidateLock", async () => {
        removeCreateHook();
        reachedCreate = true;
        await createGate;
      });
      const removeEndHook = setTreeHook("endUse.afterRevalidate", async () => {
        removeEndHook();
        const [self] = await currentDrizzleDb(db).execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        // Its own connection: started here, it would otherwise join purge's transaction.
        created = runOutsideDrizzleTransaction(() =>
          s.model(beacon).now("write", {
            command: "create",
            path: "kb://carry/sub/new",
            content: "Beacon's new text.",
          }),
        );
        for (let tries = 0; tries < 300 && !reachedCreate; tries += 1) {
          const [waiting] = await db.execute<{ pid: number }>(sql`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${Number(self?.pid)}::int = ANY(pg_blocking_pids(pid))`);
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
      try {
        const run = await interleave(
          db,
          () => s.writer.move("carry", "kb://carry"),
          "moves.beforeInstall",
          () => runtime.app.recovery.purgeWorks(),
          { waitMs: 3_000 },
        );
        expect.soft(run.bWaited, "purge waited on the move's namespace").toBe(true);
        expect.soft(run.a, "moved").toMatchObject({ ok: true, value: { ok: true } });
        expect.soft(run.b, "purged").toMatchObject({ ok: true, value: 1 });
      } finally {
        releaseCreate();
        removeCreateHook();
        removeEndHook();
      }
      const made = (await created) as { isError?: boolean; output?: unknown } | null;
      expect.soft(made?.isError, `Beacon's create: ${JSON.stringify(made?.output)}`).toBeFalsy();
      expect.soft(await row(ori), "ori tombstoned").toMatchObject({ tombstone: true });
      expect
        .soft(await s.view(beacon).read("kb://carry/sub/new"), "Beacon reads its create")
        .toMatchObject({
          ok: true,
          value: { content: expect.stringContaining("Beacon's new text.") },
        });
      expect
        .soft(
          await db
            .select({ name: documents.name })
            .from(documents)
            .innerJoin(folders, eq(folders.id, documents.folderId))
            .where(and(isNull(documents.deletedAt), isNotNull(folders.deletedAt))),
          "no live document under a tombstoned folder",
        )
        .toEqual([]);
    });

    it("warns once a create's candidate picker repairs a hidden document no draft uses (D-R3)", async () => {
      const eventSink = createInMemoryEventSink();
      const { s } = await start({ eventSink });
      const [first, second] = [await s.work("First", "draft"), await s.work("Second", "draft")];
      const stray = await s.model(first).create("lore/stray", "Stray.");
      // A bug's leftover: the draft's use is gone, the node is still hidden and live.
      await db.delete(draftTreeChanges).where(eq(draftTreeChanges.nodeId, stray));
      const made = await s.model(second).create("lore/stray", "Second's stray.");
      expect.soft(made, "a fresh document, not the stray").not.toBe(stray);
      expect.soft(await row(stray), "the stray tombstoned").toMatchObject({ tombstone: true });
      expect
        .soft(await storageOf(stray), "released")
        .toEqual({ yjs: 0, branches: 0, projection: 0 });
      expect
        .soft(
          eventSink.events.filter(
            (event) => event.source === "context.hidden-node" && event.name === "repaired",
          ),
          "one warn event",
        )
        .toMatchObject([{ level: "warn", payload: { documentIds: [stray] } }]);
    });
  });
}
