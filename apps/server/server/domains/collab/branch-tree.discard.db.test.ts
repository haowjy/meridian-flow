/**
 * Discard and purge leave nothing live and release storage (contract §12, §2.6, ledger D-1 to D-3): a hidden document branches share stays while any of them uses it, and the last one's Discard tombstones it and its hidden folders, releasing its live Yjs, every draft on it and a picture's bytes, while links written ahead of it read "Doesn't exist yet" and bind to the next live document; two branches discarding it at once leave one tombstone; a purged Work's branches go through the locked kernel, never the active-Work command.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - current branch tree discard persistence protocol (kb/decisions/collab/drafts/model/shared-branch-per-work.md)
 */

import type { DocumentId } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  branchTreeChanges,
  documentDrafts,
  documentMarkdownProjections,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
  folders,
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
import { setTestHook } from "../../shared/test-hooks.js";
import {
  type BranchTreeScenario,
  branchTreeScenario,
  type ScenarioRuntime,
} from "../../test-support/branch-tree-scenario.js";
import { useComposedRuntimes } from "../../test-support/composed-runtime.js";
import { deleteDrizzleRows } from "../../test-support/drizzle-reset.js";
import { interleave } from "../../test-support/lock-interleave.js";
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
      return { runtime, s: await branchTreeScenario(db, { runtime, runtimes }) };
    }

    /** A live picture the writer uploaded at `path`. */
    async function livePicture(runtime: ScenarioRuntime, s: BranchTreeScenario, path: string) {
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

    /** What storage the document still holds (R8): live Yjs rows, drafts holding inline content, its projection. */
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
        drafts: await count(
          db
            .select()
            .from(documentDrafts)
            .where(
              and(
                eq(documentDrafts.documentId, id),
                sql`octet_length(${documentDrafts.state}) > 0`,
              ),
            ),
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
    async function foldersNamed(s: BranchTreeScenario, name: string) {
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
        .select({ branchId: branchTreeChanges.branchId })
        .from(branchTreeChanges)
        .where(eq(branchTreeChanges.nodeId, id));
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

    it("leaves one tombstone and no orphan when two branches discard a shared document at once (D-2)", async () => {
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
      expect.soft(run.bWaited, "the other waits on its locks").toBe(true);
      expect.soft(run.b, "Discard all").toMatchObject({ ok: true, value: { status: "discarded" } });
      expect
        .soft(await row(ori), "one tombstone")
        .toEqual({ hidden: true, tombstone: true, version: versionBefore + 1n });
      expect.soft(await rowsNaming(ori), "no row names it").toEqual([]);
      expect.soft(await storageOf(ori), "released").toEqual({ yjs: 0, drafts: 0, projection: 0 });
      expect.soft(await foldersNamed(s, "lore"), "no hidden folder left behind").toEqual([]);
    });

    it("purges a deleted Work's branches through the kernel, never the public Discard (D-3)", async () => {
      const { runtime, s } = await start();
      const doomed = await s.work("Doomed", "draft");
      const plan = await s.model(doomed).create("notes/plan", "The plan.");
      await livePicture(runtime, s, "charts/chart.png");
      await s.model(doomed).copy("charts/chart.png", "art/map.png");
      const chapter = await s.writer.createDocument("chapter", "Live words.");
      await s.model(doomed).edit("chapter", "Live words.", "Drafted words.");
      const items = (await s.review(doomed)).items;
      const map = items.find((item) => item.binary)?.documentId as DocumentId;
      const branchId = items[0]?.branchId ?? "";
      expect.soft(items.map((item) => item.documentId).sort()).toEqual([plan, map, chapter].sort());

      await runtime.ports.workRepo.softDelete(doomed.id);
      await expect(
        s.discard(doomed, "all", { branchId }),
        "the public command refuses",
      ).rejects.toThrow();
      expect.soft(await s.branchStatuses(doomed), "and left the branch alone").toEqual(["active"]);
      expect.soft(await row(plan), "its create still hidden").toMatchObject({ tombstone: false });

      expect.soft(await s.purge(doomed), "purged").toBe(1);
      expect.soft(await s.branchStatuses(doomed), "its branches are gone").toEqual([]);
      for (const created of [plan, map]) {
        expect.soft(await row(created), "tombstoned, still hidden").toMatchObject({
          hidden: true,
          tombstone: true,
        });
        expect
          .soft(await storageOf(created), "released")
          .toEqual({ yjs: 0, drafts: 0, projection: 0 });
      }
      expect.soft(await objectAt(runtime, map), "the picture's bytes").toBe("not_found");
      expect.soft(await foldersNamed(s, "notes"), "no hidden folder stays").toEqual([]);
      expect.soft(await foldersNamed(s, "art"), "none").toEqual([]);
      expect
        .soft(await storageOf(chapter), "the edited chapter keeps its Yjs, loses the drafts")
        .toMatchObject({
          drafts: 0,
        });
      expect
        .soft(await s.view("live").read("chapter"), "and its live text")
        .toMatchObject({ ok: true, value: { content: expect.stringContaining("Live words.") } });
    });

    it("repairs a hidden document no branch uses when a read meets it (§12.4)", async () => {
      const eventSink = createInMemoryEventSink();
      const { runtime, s } = await start({ eventSink });
      const drafting = await s.work("Drafting", "draft");
      const stray = await s.model(drafting).create("lore/stray", "Stray.");
      // A bug's leftover: the branch's use is gone, the node is still hidden and live.
      await db.delete(branchTreeChanges).where(eq(branchTreeChanges.nodeId, stray));
      const holder = await s.writer.createDocument("chapter", "Chapter.");
      const resolved = await handleDocumentLinkResolveRequest(
        {
          projectRepo: runtime.app.projectRepo,
          documentLinks: runtime.app.documentLinks,
          linkScopes: runtime.app.linkScopes,
          workAuthorityResolver: runtime.app.workAuthorityResolver,
          fileAccess: runtime.app.fileAccess,
          branches: runtime.app.documentSync.branches,
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
      expect.soft(await storageOf(stray), "released").toEqual({ yjs: 0, drafts: 0, projection: 0 });
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
      const removeCreateHook = setTestHook("createInBranch.afterCandidateLock", async () => {
        removeCreateHook();
        reachedCreate = true;
        await createGate;
      });
      const removeEndHook = setTestHook("endUse.afterRevalidate", async () => {
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

    it("warns once a create's candidate picker repairs a hidden document no branch uses (D-R3)", async () => {
      const eventSink = createInMemoryEventSink();
      const { s } = await start({ eventSink });
      const [first, second] = [await s.work("First", "draft"), await s.work("Second", "draft")];
      const stray = await s.model(first).create("lore/stray", "Stray.");
      // A bug's leftover: the branch's use is gone, the node is still hidden and live.
      await db.delete(branchTreeChanges).where(eq(branchTreeChanges.nodeId, stray));
      const made = await s.model(second).create("lore/stray", "Second's stray.");
      expect.soft(made, "a fresh document, not the stray").not.toBe(stray);
      expect.soft(await row(stray), "the stray tombstoned").toMatchObject({ tombstone: true });
      expect.soft(await storageOf(stray), "released").toEqual({ yjs: 0, drafts: 0, projection: 0 });
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
