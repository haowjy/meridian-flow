/**
 * The tree list's store: the rows never trail the list.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the list is stored through the document journal, keyed by the project's `tree_list_id`
 * - admission checks, journals and writes the rows in one transaction under the list's lock
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  branches,
  branchTreeNodes,
  contextSources,
  documents,
  documentYjsHeads,
  documentYjsUpdates,
  projects,
  treeNodeIds,
  treeNodes,
  users,
  works,
} from "@meridian/database/schema";
import {
  branchRows,
  LIVE,
  type ProjectedRow,
  projectedRows,
  replayView,
  sourceRoot,
  TreeWriter,
} from "@meridian/project-tree";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { runWithEditConfirmation } from "../../../shared/edit-confirmation.js";
import { setTestHook } from "../../../shared/test-hooks.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
import { treeSeeder } from "../../../test-support/tree-seed.js";
import { initializeHead } from "../../collab/adapters/drizzle-document-authority-head.js";
import { createDrizzleJournal } from "../../collab/adapters/drizzle-journal.js";
import {
  closeDatabase,
  createTestDatabase,
  DOCUMENT_RUNTIME_RESET_TABLES,
  deleteDrizzleRows,
} from "../../collab/test-support/collab-postgres-harness.js";
import { createDrizzleTreeListStore } from "./drizzle-tree-list-store.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000a01";
const STRANGER = "00000000-0000-4000-8000-000000000a02";
const PROJECT = "00000000-0000-4000-8000-000000000a03";
const MANUSCRIPT = "00000000-0000-4000-8000-000000000a04";
const UNFILED = "00000000-0000-4000-8000-000000000a05";
const BRANCH = "00000000-0000-4000-8000-000000000a06";
const WORK = "00000000-0000-4000-8000-000000000a07";
const actor = `user:${ACCOUNT}`;
const list = { kind: "project", projectId: PROJECT } as const;

describe("the tree list store (postgres)", () => {
  const db = createTestDatabase();
  const journal = createDrizzleJournal(db);
  const newStore = (journalOverride = journal) =>
    createDrizzleTreeListStore({ db, journal: journalOverride });
  /** The project's list id: its own, made with the project. */
  let LIST = "";
  /** The account's list id. */
  let ACCOUNT_LIST = "";

  beforeEach(async () => {
    await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
    await db
      .insert(users)
      .values([
        conformanceUserValues(ACCOUNT, "tree-list"),
        conformanceUserValues(STRANGER, "tree-list-stranger"),
      ]);
    await db
      .insert(projects)
      .values({ id: PROJECT, userId: ACCOUNT, name: "Serial", slug: "serial" });
    LIST = (await db.select().from(projects).where(eq(projects.id, PROJECT)))[0]
      ?.treeListId as string;
    ACCOUNT_LIST = (await db.select().from(users).where(eq(users.id, ACCOUNT)))[0]
      ?.treeListId as string;
    await db.insert(contextSources).values([
      {
        id: MANUSCRIPT,
        projectId: PROJECT,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      },
      { id: UNFILED, projectId: PROJECT, name: "Unfiled", slug: "unfiled", scope: "project" },
    ]);
    await db.insert(works).values({
      id: WORK,
      projectId: PROJECT,
      createdByUserId: ACCOUNT,
      name: "Drafting",
      handle: "w1",
    });
    await db.insert(branches).values({
      id: BRANCH,
      projectId: PROJECT,
      status: "active",
      originWorkId: WORK,
      createdBy: ACCOUNT,
    });
  });
  afterAll(() => closeDatabase(db));

  /** A browser's copy of the list: its own client id, and what it has not yet sent. */
  function client(who = actor) {
    const doc = new Y.Doc({ gc: false });
    const writer = new TreeWriter(doc);
    let sent = Y.encodeStateVector(doc);
    return {
      doc,
      writer,
      actor: who,
      /** Everything made since the last call, as one update. */
      send() {
        const update = Y.encodeStateAsUpdate(doc, sent);
        sent = Y.encodeStateVector(doc);
        return update;
      },
    };
  }

  const updateCount = async () =>
    (await db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, LIST)))
      .length;

  /** The rows a fresh replay of the journal gives, for live and the Work. */
  async function replayedRows() {
    const doc = new Y.Doc({ gc: false });
    const snapshot = await journal.read(LIST);
    if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    const shown = (view: { draft: string | null }) => {
      const projection = replayView(doc, view);
      const rows = projectedRows(projection);
      for (const node of projection.nodes.values()) if (node.purged) rows.delete(node.id);
      return rows;
    };
    const live = shown(LIVE);
    return { live, branch: branchRows(live, shown({ draft: BRANCH })) };
  }

  const pick = (row: ProjectedRow) => ({
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    sourceId: row.sourceId,
    name: row.name,
    extension: row.extension,
    filetype: row.filetype,
    rank: row.rank,
    deleted: row.deleted,
  });
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

  async function storedRows() {
    const live = (await db.select().from(treeNodes)).map((row) =>
      pick({
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        sourceId: row.contextSourceId,
        name: row.name,
        extension: row.extension,
        filetype: row.fileType,
        rank: row.rank,
        deleted: row.trashRecord !== null,
      }),
    );
    const branch = (await db.select().from(branchTreeNodes)).map((row) => ({
      ...pick({
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        sourceId: row.contextSourceId,
        name: row.name,
        extension: row.extension,
        filetype: row.fileType,
        rank: row.rank,
        deleted: row.deleted,
      }),
      existsOnlyInDraft: row.existsOnlyInDraft,
    }));
    return { live: byId(live), branch: byId(branch) };
  }

  async function expectRowsEqualReplay() {
    const replayed = await replayedRows();
    const stored = await storedRows();
    expect(stored.live).toEqual(byId([...replayed.live.values()].map(pick)));
    expect(stored.branch).toEqual(
      byId(
        [...replayed.branch.values()].map((row) => ({
          ...pick(row),
          existsOnlyInDraft: row.existsOnlyInDraft,
        })),
      ),
    );
  }

  /** One browser's session: a folder with two chapters, a rename, a move, and a draft. */
  async function session(store: ReturnType<typeof newStore>, tag: string) {
    const c = client();
    const send = async () => {
      const result = await store.admit({ list, accountId: ACCOUNT, update: c.send() });
      expect(result).toMatchObject({ ok: true });
    };
    const folder = c.writer.create(LIVE, actor, {
      kind: "folder",
      name: `Part ${tag}`,
      parent: sourceRoot(MANUSCRIPT),
    });
    await send();
    const one = c.writer.create(LIVE, actor, {
      kind: "document",
      name: `one ${tag}`,
      parent: folder.node,
      filetype: "markdown",
    });
    const two = c.writer.create(LIVE, actor, {
      kind: "document",
      name: `two ${tag}`,
      parent: folder.node,
      filetype: "markdown",
    });
    await send();
    c.writer.rename(LIVE, actor, one.node, `first ${tag}`);
    c.writer.move(LIVE, actor, two.node, sourceRoot(UNFILED));
    await send();
    c.writer.create({ draft: BRANCH }, actor, {
      kind: "document",
      name: `draft ${tag}`,
      parent: folder.node,
      filetype: "markdown",
    });
    c.writer.delete(LIVE, actor, one.node);
    await send();
  }

  it("keeps the rows equal to a fresh replay of the journal while several connections admit at once", async () => {
    // Two stores stand for two server processes: each holds its own copy of the list.
    const stores = [newStore(), newStore()];
    await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((tag, at) => session(stores[at % 2], tag)),
    );

    expect(await updateCount()).toBeGreaterThanOrEqual(24);
    const { live, branch } = await storedRows();
    expect(live.filter((row) => row.kind === "folder")).toHaveLength(6);
    expect(live.filter((row) => row.kind === "document")).toHaveLength(12);
    expect(branch.some((row) => row.existsOnlyInDraft)).toBe(true);
    await expectRowsEqualReplay();
    // Each created document has its documents row, from the same transaction.
    expect(await db.select().from(documents)).toHaveLength(18);
  });

  describe("a hostile update", () => {
    async function seededList() {
      const store = newStore();
      const honest = client();
      const folder = honest.writer.create(LIVE, actor, {
        kind: "folder",
        name: "Part",
        parent: sourceRoot(MANUSCRIPT),
      });
      await store.admit({ list, accountId: ACCOUNT, update: honest.send() });
      return { store, honest, folder };
    }

    it("stores nothing and leaves the list admitting", async () => {
      const { store, honest, folder } = await seededList();
      const stranger = client();
      Y.applyUpdate(stranger.doc, Y.encodeStateAsUpdate(honest.doc));
      stranger.send();
      stranger.writer.create(LIVE, `user:${STRANGER}`, {
        kind: "document",
        filetype: "markdown",
        name: "forged",
        parent: folder.node,
      });
      const forged = stranger.send();

      const reused = client();
      Y.applyUpdate(reused.doc, Y.encodeStateAsUpdate(honest.doc));
      const taken = reused.writer.author(LIVE, actor, {
        type: "create",
        node: crypto.randomUUID(),
        kind: "document",
        name: "x",
        filetype: "markdown",
        parent: folder.node,
        source: MANUSCRIPT,
        rank: "a1",
      });
      expect(await store.admit({ list, accountId: ACCOUNT, update: reused.send() })).toMatchObject({
        ok: true,
      });
      const again = client();
      Y.applyUpdate(again.doc, Y.encodeStateAsUpdate(honest.doc));
      again.writer.author(
        LIVE,
        actor,
        { type: "rename", node: folder.node, name: "Renamed", fromName: "Part" },
        { id: taken.id },
      );
      const reusedId = again.send();

      // A create naming a document some other row already has.
      const owned = crypto.randomUUID();
      await treeSeeder(db).document(UNFILED, "elsewhere", { id: owned });
      const takeover = client();
      Y.applyUpdate(takeover.doc, Y.encodeStateAsUpdate(honest.doc));
      takeover.writer.create(LIVE, actor, {
        kind: "document",
        filetype: "markdown",
        name: "stolen",
        parent: folder.node,
        node: owned,
      });
      const stolen = takeover.send();

      // A deletion from the list.
      const deleting = client();
      Y.applyUpdate(deleting.doc, Y.encodeStateAsUpdate(honest.doc));
      deleting.doc.getArray("ops").delete(0);
      const deletion = Y.encodeStateAsUpdate(deleting.doc, Y.encodeStateVector(honest.doc));

      const before = { updates: await updateCount(), rows: await storedRows() };
      for (const update of [forged, reusedId, stolen, deletion, new Uint8Array([1, 2, 3])]) {
        const result = await store.admit({ list, accountId: ACCOUNT, update });
        expect(result.ok).toBe(false);
      }
      // A stranger's connection is read-only.
      expect((await store.admit({ list, accountId: STRANGER, update: honest.send() })).ok).toBe(
        false,
      );
      expect({ updates: await updateCount(), rows: await storedRows() }).toEqual(before);

      honest.writer.rename(LIVE, actor, folder.node, "Part One");
      expect(await store.admit({ list, accountId: ACCOUNT, update: honest.send() })).toMatchObject({
        ok: true,
      });
      await expectRowsEqualReplay();
    });

    it("admits a record into a Work that is not the account's, settles it refused and keeps the create in Unfiled", async () => {
      const { store, honest } = await seededList();
      honest.writer.create({ draft: crypto.randomUUID() }, actor, {
        kind: "document",
        name: "orphan",
        parent: sourceRoot(MANUSCRIPT),
        filetype: "markdown",
      });
      expect(await store.admit({ list, accountId: ACCOUNT, update: honest.send() })).toMatchObject({
        ok: true,
      });
      const kept = (await storedRows()).live.find((row) => row.name === "orphan");
      expect(kept?.sourceId).toBe(UNFILED);
      await expectRowsEqualReplay();
    });
  });

  describe("a server copy", () => {
    it("catches up from the journal's new rows, and is reloaded after a failed transaction", async () => {
      let reads = 0;
      let tails = 0;
      const counting = {
        ...journal,
        read: (...args: Parameters<typeof journal.read>) => {
          reads += 1;
          return journal.read(...args);
        },
        readUpdates: (...args: Parameters<typeof journal.readUpdates>) => {
          tails += 1;
          return journal.readUpdates(...args);
        },
      };
      const behind = newStore(counting);
      const ahead = newStore();
      const c = client();
      const admit = (store: ReturnType<typeof newStore>) =>
        store.admit({ list, accountId: ACCOUNT, update: c.send() });

      c.writer.create(LIVE, actor, { kind: "folder", name: "A", parent: sourceRoot(MANUSCRIPT) });
      await admit(behind);
      expect([reads, tails]).toEqual([1, 0]);

      c.writer.create(LIVE, actor, { kind: "folder", name: "B", parent: sourceRoot(MANUSCRIPT) });
      await admit(ahead);
      c.writer.create(LIVE, actor, { kind: "folder", name: "C", parent: sourceRoot(MANUSCRIPT) });
      await admit(behind);
      expect([reads, tails]).toEqual([1, 1]);
      await expectRowsEqualReplay();

      // A transaction that fails after it changed the copy leaves a copy ahead of the journal.
      const remove = setTestHook("treeList.afterRows", async () => {
        remove();
        throw new Error("the connection dropped");
      });
      c.writer.create(LIVE, actor, { kind: "folder", name: "D", parent: sourceRoot(MANUSCRIPT) });
      await expect(admit(behind)).rejects.toThrow("the connection dropped");
      expect(await storedRows().then((rows) => rows.live.map((row) => row.name).sort())).toEqual([
        "A",
        "B",
        "C",
      ]);
      c.writer.create(LIVE, actor, { kind: "folder", name: "E", parent: sourceRoot(MANUSCRIPT) });
      await admit(behind);
      expect(reads).toBe(2);
      await expectRowsEqualReplay();
    });
  });

  describe("a process killed during an admission", () => {
    const root = path.resolve(import.meta.dirname, "../../../../../..");

    async function killAt(step: string) {
      // Live rows and a Work's rows in one transaction.
      const c = client();
      const folder = c.writer.create(LIVE, actor, {
        kind: "folder",
        name: "Killed",
        parent: sourceRoot(MANUSCRIPT),
      });
      c.writer.create({ draft: BRANCH }, actor, {
        kind: "document",
        name: "killed draft",
        parent: folder.node,
        filetype: "markdown",
      });
      const dir = mkdtempSync(path.join(tmpdir(), "tree-list-kill-"));
      const ready = path.join(dir, "ready");
      const child = spawn(
        // Node itself, not the `tsx` wrapper: SIGKILL on the wrapper would leave the writer alive.
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "apps/server/server/test-support/tree-list-crash-writer.ts"),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            STEP: step,
            READY_PATH: ready,
            PROJECT_ID: PROJECT,
            ACCOUNT_ID: ACCOUNT,
            UPDATE: Buffer.from(c.send()).toString("base64"),
          },
          stdio: "inherit",
        },
      );
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      await expect.poll(() => existsSync(ready), { timeout: 60_000, interval: 50 }).toBe(true);
      child.kill("SIGKILL");
      await exited;
      rmSync(dir, { recursive: true, force: true });
      // The server drops the dead connection's transaction.
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'idle in transaction'`,
          );
          return row?.n;
        })
        .toBe(0);
    }

    it.each([
      "treeList.afterLock",
      "treeList.afterAppend",
      "treeList.afterLiveRows",
      "treeList.afterRows",
    ])("leaves neither the record nor its rows when killed at %s", async (step) => {
      await killAt(step);
      expect(await updateCount()).toBe(0);
      expect(await storedRows()).toEqual({ live: [], branch: [] });
      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(treeNodeIds)).toEqual([]);

      // And the list admits as before.
      const c = client();
      c.writer.create(LIVE, actor, {
        kind: "folder",
        name: "After",
        parent: sourceRoot(MANUSCRIPT),
      });
      expect(await newStore().admit({ list, accountId: ACCOUNT, update: c.send() })).toMatchObject({
        ok: true,
      });
      await expectRowsEqualReplay();
    });

    it("leaves the record and its rows when killed after the commit", async () => {
      await killAt("treeList.afterCommit");
      expect(await updateCount()).toBe(1);
      const stored = await storedRows();
      expect(stored.live.map((row) => row.name)).toEqual(["Killed"]);
      expect(stored.branch.map((row) => row.name)).toEqual(["killed draft"]);
      await expectRowsEqualReplay();
    });
  });

  describe("a list's identity", () => {
    it("is never a node's, a document's or another list's id", async () => {
      for (const taken of [LIST, ACCOUNT_LIST]) {
        const c = client();
        c.writer.create(LIVE, actor, {
          kind: "document",
          name: "alias",
          parent: sourceRoot(MANUSCRIPT),
          filetype: "markdown",
          node: taken,
        });
        expect(await newStore().admit({ list, accountId: ACCOUNT, update: c.send() })).toEqual({
          ok: false,
          reason: "a node id already in use",
          record: expect.any(String),
        });
      }
      expect(await updateCount()).toBe(0);
      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(treeNodeIds)).toEqual([]);

      // A document row that had a list's id would still take no head with it, and no document
      // adopts a list's head.
      await db.insert(documents).values({ id: LIST, projectId: PROJECT });
      await db.delete(documents).where(eq(documents.id, LIST));
      expect(
        await db.select().from(documentYjsHeads).where(eq(documentYjsHeads.documentId, LIST)),
      ).toHaveLength(1);
      await expect(initializeHead(db, LIST as never)).rejects.toThrow("tree_list");
    });

    it("keeps a node id with the one list that claimed it, when two lists admit it at once", async () => {
      const project2 = "00000000-0000-4000-8000-000000000b03";
      const manuscript2 = "00000000-0000-4000-8000-000000000b04";
      await db
        .insert(projects)
        .values({ id: project2, userId: ACCOUNT, name: "Second", slug: "second" });
      await db.insert(contextSources).values({
        id: manuscript2,
        projectId: project2,
        name: "Manuscript",
        slug: "manuscript",
        scope: "project",
      });
      const second = { kind: "project", projectId: project2 } as const;
      for (let round = 0; round < 3; round++) {
        const node = crypto.randomUUID();
        const one = client();
        one.writer.create(LIVE, actor, {
          kind: "folder",
          name: "First",
          parent: sourceRoot(MANUSCRIPT),
          node,
        });
        const two = client();
        two.writer.create(LIVE, actor, {
          kind: "folder",
          name: "Second",
          parent: sourceRoot(manuscript2),
          node,
        });
        // Both see the id unused before either has claimed it.
        let reached = 0;
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const remove = setTestHook("treeList.afterLock", async () => {
          if (++reached === 2) release();
          await gate;
        });
        const results = await Promise.all([
          newStore().admit({ list, accountId: ACCOUNT, update: one.send() }),
          newStore().admit({ list: second, accountId: ACCOUNT, update: two.send() }),
        ]);
        remove();

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.find((result) => !result.ok)).toMatchObject({
          reason: "a node id already in use",
        });
        const [claim] = await db.select().from(treeNodeIds).where(eq(treeNodeIds.id, node));
        const rows = await db.select().from(treeNodes).where(eq(treeNodes.id, node));
        expect(rows.map((row) => row.listId)).toEqual([claim?.listId]);
      }
    });
  });

  it("reloads a copy that is behind a compaction instead of catching up from the rows left", async () => {
    const [a, b] = [newStore(), newStore()];
    const c = client();
    const admit = (store: ReturnType<typeof newStore>, name: string) => {
      c.writer.create(LIVE, actor, { kind: "folder", name, parent: sourceRoot(MANUSCRIPT) });
      return store.admit({ list, accountId: ACCOUNT, update: c.send() });
    };
    await admit(a, "A");
    await admit(b, "B");
    await journal.compact(LIST, new Date(Date.now() + 60_000));
    expect(await updateCount()).toBe(0);

    await admit(a, "C");
    expect((await storedRows()).live.map((row) => row.name).sort()).toEqual(["A", "B", "C"]);
    await expectRowsEqualReplay();
  });

  it("keeps the server's items under one reserved client id while two processes write in turn", async () => {
    const stores = [newStore(), newStore()];
    for (let at = 0; at < 6; at++) {
      await stores[at % 2]?.submit({
        lists: [list],
        make: ([{ writer }]) => {
          writer.create(LIVE, actor, {
            kind: "folder",
            name: `Made ${at}`,
            parent: sourceRoot(MANUSCRIPT),
          });
        },
      });
    }
    const doc = new Y.Doc({ gc: false });
    const snapshot = await journal.read(LIST);
    for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
    expect([...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()]).toEqual([1]);
    expect((await storedRows()).live).toHaveLength(6);
    await expectRowsEqualReplay();
  });

  it("takes a Work's lock before the list's, so a transaction holding the Work cannot deadlock a bound write", async () => {
    const other = newStore();
    const store = newStore();
    let holding = () => {};
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // B holds the Work, then wants the list; A, bound to the same Work, wants both.
    const b = runInDrizzleTransaction(db, async () => {
      await lockSeamWorks(currentDrizzleDb(db), [WORK]);
      holding();
      // Until A is waiting on a lock, with the Work in B's hand.
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return row?.n;
        })
        .toBeGreaterThan(0);
      return other.submit({ lists: [list], make: () => {} });
    });
    await held;
    const a = runWithEditConfirmation(
      { workIds: [WORK], lineageRootIds: [], confirm: async () => {}, covers: async () => true },
      () =>
        store.submit({
          lists: [list],
          make: ([{ writer }]) => {
            writer.create(LIVE, actor, {
              kind: "folder",
              name: "Bound",
              parent: sourceRoot(MANUSCRIPT),
            });
          },
        }),
    );
    expect((await Promise.allSettled([a, b])).map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect((await storedRows()).live.map((row) => row.name)).toEqual(["Bound"]);
  });

  describe("a commit that fails after the body succeeded", () => {
    it("stores nothing and the list admits again, when a deferred constraint fails at COMMIT", async () => {
      const store = newStore();
      const c = client();
      const folder = c.writer.create(LIVE, actor, {
        kind: "folder",
        name: "Part",
        parent: sourceRoot(MANUSCRIPT),
      });
      const child = c.writer.create(LIVE, actor, {
        kind: "document",
        name: "one",
        parent: folder.node,
        filetype: "markdown",
      });
      await store.admit({ list, accountId: ACCOUNT, update: c.send() });
      const before = { updates: await updateCount(), rows: await storedRows() };

      // Rows written after the body leave the child under a parent no row has: the constraint
      // that says so is deferred, so only COMMIT refuses.
      const remove = setTestHook("treeList.afterRows", async () => {
        await currentDrizzleDb(db).execute(
          sql`UPDATE tree_nodes SET parent_id = gen_random_uuid() WHERE id = ${child.node}::uuid`,
        );
      });
      await expect(
        store.submit({
          lists: [list],
          make: ([{ writer }]) => {
            writer.create(LIVE, actor, {
              kind: "folder",
              name: "Refused",
              parent: sourceRoot(MANUSCRIPT),
            });
          },
        }),
      ).rejects.toThrow();
      remove();
      expect({ updates: await updateCount(), rows: await storedRows() }).toEqual(before);

      c.writer.create(LIVE, actor, { kind: "folder", name: "After", parent: sourceRoot(UNFILED) });
      expect(await store.admit({ list, accountId: ACCOUNT, update: c.send() })).toMatchObject({
        ok: true,
      });
      await expectRowsEqualReplay();
    });
  });

  it("takes the list's journal and rows with its project, and leaves a document's delete out of it", async () => {
    const c = client();
    c.writer.create(LIVE, actor, { kind: "folder", name: "Gone", parent: sourceRoot(MANUSCRIPT) });
    await newStore().admit({ list, accountId: ACCOUNT, update: c.send() });
    expect(await updateCount()).toBe(1);
    await db.delete(projects).where(eq(projects.id, PROJECT));
    expect(await updateCount()).toBe(0);
    expect(await db.select().from(treeNodes)).toEqual([]);
    expect(await db.select().from(treeNodeIds)).toEqual([]);
    expect(
      await db.select().from(branchTreeNodes).where(eq(branchTreeNodes.branchId, BRANCH)),
    ).toEqual([]);
  });
});
