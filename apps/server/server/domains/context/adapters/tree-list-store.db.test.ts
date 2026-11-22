/**
 * The tree list's store: the rows never trail the list.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - the list is stored as one `document_snapshots` row, `tree:<tree_list_id>`, rewritten by each change
 * - admission stores the update as sent and writes the rows in one transaction under the list's lock
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import {
  contextSources,
  documentSnapshots,
  documents,
  draftTreeNodes,
  projects,
  treeNodeIds,
  treeNodes,
  users,
  works,
} from "@meridian/database/schema";
import { freshPeerId, isServerPeer } from "@meridian/document-model";
import {
  draftRows,
  LIVE,
  type ProjectedRow,
  pendingRecords,
  projectedRows,
  replayView,
  sourceRoot,
  TreeWriter,
} from "@meridian/project-tree";
import { and, eq, sql } from "drizzle-orm";
import { LoroDoc, type VersionVector } from "loro-crdt";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  currentDrizzleDb,
  runInDrizzleSavepoint,
  runInDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { runWithEditConfirmation } from "../../../shared/edit-confirmation.js";
import { setTestHook } from "../../../shared/test-hooks.js";
import { lockSeamWorks } from "../../../shared/work-lifecycle-lock.js";
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
const DRAFT = "treelistbr01";
const WORK = "00000000-0000-4000-8000-000000000a07";
const actor = `user:${ACCOUNT}`;
const list = { kind: "project", projectId: PROJECT } as const;

describe("the tree list store (postgres)", () => {
  const db = createTestDatabase();
  const newStore = () => createDrizzleTreeListStore({ db });
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
        slug: "manuscript",
        scope: "project",
      },
      { id: UNFILED, projectId: PROJECT, slug: "unfiled", scope: "project" },
    ]);
    await db.insert(works).values({
      id: WORK,
      projectId: PROJECT,
      createdByUserId: ACCOUNT,
      name: "Drafting",
      handle: "w1",
      draftId: DRAFT,
    });
  });
  afterAll(() => closeDatabase(db));

  /** A browser's copy of the list: its own peer id, and what it has not yet sent. */
  function client(who = actor) {
    const doc = new LoroDoc();
    doc.setPeerId(freshPeerId());
    const writer = new TreeWriter(doc);
    let sent: VersionVector | undefined;
    return {
      doc,
      writer,
      actor: who,
      /** Everything made since the last call, as one update. */
      send() {
        const update = doc.export(sent ? { mode: "update", from: sent } : { mode: "update" });
        sent = doc.oplogVersion();
        return update;
      },
    };
  }

  /** The list as its stored row holds it; null when nothing was stored. */
  async function storedList(listId = LIST): Promise<LoroDoc | null> {
    const [row] = await db
      .select({ snapshot: documentSnapshots.snapshot })
      .from(documentSnapshots)
      .where(
        and(eq(documentSnapshots.roomKey, `tree:${listId}`), eq(documentSnapshots.docKey, "s")),
      );
    if (!row) return null;
    const doc = new LoroDoc();
    doc.import(row.snapshot);
    return doc;
  }

  /** The stored list's version, as JSON, for "nothing was stored" comparisons. */
  const storedVersion = async () => {
    const doc = await storedList();
    const version = doc ? JSON.stringify([...doc.oplogVersion().toJSON()]) : null;
    doc?.free();
    return version;
  };

  /** The live view of a fresh replay of the stored list. */
  async function storedReplay() {
    const doc = await storedList();
    if (!doc) throw new Error("the list was never stored");
    try {
      return replayView(doc, LIVE);
    } finally {
      doc.free();
    }
  }

  /** The rows a fresh replay of the stored list gives, for live and the Work. */
  async function replayedRows() {
    const doc = (await storedList()) ?? new LoroDoc();
    const shown = (view: { draft: string | null }) => {
      const projection = replayView(doc, view);
      const rows = projectedRows(projection);
      for (const node of projection.nodes.values()) if (node.purged) rows.delete(node.id);
      return rows;
    };
    const live = shown(LIVE);
    const draft = draftRows(live, shown({ draft: DRAFT }), pendingRecords(doc, DRAFT));
    doc.free();
    return { live, draft };
  }

  const pick = (row: ProjectedRow) => ({
    id: row.id,
    kind: row.kind,
    parentId: row.parentId,
    sourceId: row.sourceId,
    name: row.name,
    suffix: row.suffix,
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
        suffix: row.suffix,
        extension: row.extension,
        filetype: row.fileType,
        rank: row.rank,
        deleted: row.trashRecord !== null,
      }),
    );
    const draft = (await db.select().from(draftTreeNodes)).map((row) => ({
      ...pick({
        id: row.id,
        kind: row.kind,
        parentId: row.parentId,
        sourceId: row.contextSourceId,
        name: row.name,
        suffix: row.suffix,
        extension: row.extension,
        filetype: row.fileType,
        rank: row.rank,
        deleted: row.deleted,
      }),
      existsOnlyInDraft: row.existsOnlyInDraft,
      changed: row.changed,
    }));
    return { live: byId(live), draft: byId(draft) };
  }

  async function expectRowsEqualReplay() {
    const replayed = await replayedRows();
    const stored = await storedRows();
    expect(stored.live).toEqual(byId([...replayed.live.values()].map(pick)));
    expect(stored.draft).toEqual(
      byId(
        [...replayed.draft.values()].map((row) => ({
          ...pick(row),
          existsOnlyInDraft: row.existsOnlyInDraft,
          changed: row.changed,
        })),
      ),
    );
  }

  /** One browser's session: a folder with two chapters, a rename, a move, and a draft. */
  async function session(store: ReturnType<typeof newStore>, tag: string) {
    const c = client();
    const send = async () => {
      const result = await store.admit({ list, accountId: ACCOUNT, update: c.send() });
      expect(result.committed).not.toBeNull();
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
    c.writer.create({ draft: DRAFT }, actor, {
      kind: "document",
      name: `draft ${tag}`,
      parent: folder.node,
      filetype: "markdown",
    });
    c.writer.delete(LIVE, actor, one.node);
    await send();
  }

  it("keeps the rows equal to a fresh replay of the stored list while several connections admit at once", async () => {
    // Two stores stand for two server processes: each holds its own copy of the list.
    const stores = [newStore(), newStore()];
    await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((tag, at) => session(stores[at % 2], tag)),
    );

    const { live, draft } = await storedRows();
    expect(live.filter((row) => row.kind === "folder")).toHaveLength(6);
    expect(live.filter((row) => row.kind === "document")).toHaveLength(12);
    expect(draft.some((row) => row.existsOnlyInDraft)).toBe(true);
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

    it("stores a list update as sent, turns away bytes that are no update, and leaves the list admitting", async () => {
      const { store, honest, folder } = await seededList();
      const before = { version: await storedVersion(), rows: await storedRows() };
      await expect(
        store.admit({ list, accountId: ACCOUNT, update: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow();
      // An account that does not own the list has nothing to admit to.
      await expect(
        store.admit({ list, accountId: STRANGER, update: honest.send() }),
      ).rejects.toThrow();
      expect({ version: await storedVersion(), rows: await storedRows() }).toEqual(before);

      // A deletion from the list is no edit an honest copy makes, and it is stored as sent: the
      // replay reads the list as it stands.
      const deleting = client();
      deleting.doc.import(honest.doc.export({ mode: "snapshot" }));
      const seen = deleting.doc.oplogVersion();
      deleting.doc.getList("ops").delete(0, 1);
      deleting.doc.commit();
      const deletion = deleting.doc.export({ mode: "update", from: seen });
      expect(
        (await store.admit({ list, accountId: ACCOUNT, update: deletion })).committed,
      ).not.toBeNull();
      await expectRowsEqualReplay();
      honest.doc.import(deletion);

      honest.writer.rename(LIVE, actor, folder.node, "Part One");
      expect(
        (await store.admit({ list, accountId: ACCOUNT, update: honest.send() })).committed,
      ).not.toBeNull();
      await expectRowsEqualReplay();
    });

    it("stamps a create raced into a closed Work dropped: no row, no draft, and it stays dropped when the Work comes back", async () => {
      const { store, honest, folder } = await seededList();
      await db.update(works).set({ archivedAt: new Date() }).where(eq(works.id, WORK));
      const raced = honest.writer.create({ draft: DRAFT }, actor, {
        kind: "document",
        filetype: "markdown",
        name: "raced",
        parent: sourceRoot(MANUSCRIPT),
      });
      const inside = honest.writer.create({ draft: DRAFT }, actor, {
        kind: "document",
        filetype: "markdown",
        name: "also raced",
        parent: folder.node,
      });
      await store.admit({ list, accountId: ACCOUNT, update: honest.send() });
      const settled = await storedReplay();
      expect(settled.dropped.map((each) => [each.record.node, each.reason])).toEqual([
        [raced.node, "Work was closed"],
        [inside.node, "Work was closed"],
      ]);
      expect(await db.select().from(documents).where(eq(documents.id, raced.node))).toEqual([]);
      expect(
        await db.select().from(draftTreeNodes).where(eq(draftTreeNodes.id, raced.node)),
      ).toEqual([]);
      await db.update(works).set({ archivedAt: null }).where(eq(works.id, WORK));
      honest.writer.rename(LIVE, actor, folder.node, "Part Three");
      await store.admit({ list, accountId: ACCOUNT, update: honest.send() });
      expect((await storedReplay()).dropped).toHaveLength(2);
      expect(await db.select().from(documents).where(eq(documents.id, raced.node))).toEqual([]);
    });
  });

  describe("a server copy", () => {
    it("catches up from the stored list, and is reloaded after a failed transaction", async () => {
      const behind = newStore();
      const ahead = newStore();
      const c = client();
      const admit = (store: ReturnType<typeof newStore>) =>
        store.admit({ list, accountId: ACCOUNT, update: c.send() });

      c.writer.create(LIVE, actor, { kind: "folder", name: "A", parent: sourceRoot(MANUSCRIPT) });
      await admit(behind);

      c.writer.create(LIVE, actor, { kind: "folder", name: "B", parent: sourceRoot(MANUSCRIPT) });
      await admit(ahead);
      c.writer.create(LIVE, actor, { kind: "folder", name: "C", parent: sourceRoot(MANUSCRIPT) });
      await admit(behind);
      await expectRowsEqualReplay();

      // A transaction that fails after it changed the copy leaves a copy ahead of the stored list.
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
      // The client's copy holds D, which the failed transaction did not store: it sends all.
      await behind.admit({ list, accountId: ACCOUNT, update: c.doc.export({ mode: "update" }) });
      expect((await storedRows()).live.map((row) => row.name).sort()).toEqual([
        "A",
        "B",
        "C",
        "D",
        "E",
      ]);
      await expectRowsEqualReplay();
    });
  });

  describe("a rolled-back transaction", () => {
    it("takes the copies it held with it, however many savepoints and no-change reads came after the change", async () => {
      const store = newStore();
      const create = (name: string) =>
        store.submit({
          lists: [list],
          make: ([{ writer }]) =>
            writer.create(LIVE, actor, { kind: "folder", name, parent: sourceRoot(MANUSCRIPT) }),
        });
      await create("Kept");
      await expect(
        runInDrizzleTransaction(db, async () => {
          await runInDrizzleSavepoint(db, () => create("Phantom"));
          // A read that changes nothing, after a change its parent has not committed.
          await store.submit({ lists: [list], make: () => {} });
          throw new Error("refused");
        }),
      ).rejects.toThrow("refused");

      await create("Next");
      expect(await storedRows().then((rows) => rows.live.map((row) => row.name).sort())).toEqual([
        "Kept",
        "Next",
      ]);
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
      c.writer.create({ draft: DRAFT }, actor, {
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
      expect(await storedVersion()).toBeNull();
      expect(await storedRows()).toEqual({ live: [], draft: [] });
      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(treeNodeIds)).toEqual([]);

      // And the list admits as before.
      const c = client();
      c.writer.create(LIVE, actor, {
        kind: "folder",
        name: "After",
        parent: sourceRoot(MANUSCRIPT),
      });
      expect(
        (await newStore().admit({ list, accountId: ACCOUNT, update: c.send() })).committed,
      ).not.toBeNull();
      await expectRowsEqualReplay();
    });

    it("leaves the record and its rows when killed after the commit", async () => {
      await killAt("treeList.afterCommit");
      expect(await storedVersion()).not.toBeNull();
      const stored = await storedRows();
      expect(stored.live.map((row) => row.name)).toEqual(["Killed"]);
      expect(stored.draft.map((row) => row.name)).toEqual(["killed draft"]);
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
        // The record is in the list (a ghost its writer sees), with no row and no claim.
        await newStore().admit({ list, accountId: ACCOUNT, update: c.send() });
      }
      expect(await db.select().from(documents)).toEqual([]);
      expect(await db.select().from(treeNodeIds)).toEqual([]);
      expect(await db.select().from(treeNodes)).toEqual([]);

      // An id that is no uuid gets no row, and a sync after a record of one still writes the rest.
      const store = newStore();
      const c = client();
      for (const node of ["not-a-uuid"])
        c.writer.create(LIVE, actor, {
          kind: "document",
          filetype: "markdown",
          name: "stolen",
          parent: sourceRoot(MANUSCRIPT),
          node,
        });
      const fine = c.writer.create(LIVE, actor, {
        kind: "folder",
        name: "Fine",
        parent: sourceRoot(MANUSCRIPT),
      });
      await store.admit({ list, accountId: ACCOUNT, update: c.send() });
      c.writer.rename(LIVE, actor, fine.node, "Fine too");
      await store.admit({ list, accountId: ACCOUNT, update: c.send() });
      const names = (await storedRows()).live.map((row) => [row.id, row.name]);
      expect(names).toContainEqual([fine.node, "Fine too"]);
      expect(names.some(([id]) => id === "not-a-uuid")).toBe(false);
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

        expect(results).toHaveLength(2);
        const [claim] = await db.select().from(treeNodeIds).where(eq(treeNodeIds.id, node));
        const rows = await db.select().from(treeNodes).where(eq(treeNodes.id, node));
        expect(rows.map((row) => row.listId)).toEqual([claim?.listId]);
      }
    });
  });

  it("writes the server's records under server peer ids, one per process's copy, while two processes write in turn", async () => {
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
    const doc = await storedList();
    const peers = [...(doc?.oplogVersion().toJSON().keys() ?? [])];
    doc?.free();
    expect(peers).toHaveLength(2);
    expect(peers.every((peer) => isServerPeer(peer as never))).toBe(true);
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
      const before = { version: await storedVersion(), rows: await storedRows() };

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
      expect({ version: await storedVersion(), rows: await storedRows() }).toEqual(before);

      c.writer.create(LIVE, actor, { kind: "folder", name: "After", parent: sourceRoot(UNFILED) });
      expect(
        (await store.admit({ list, accountId: ACCOUNT, update: c.send() })).committed,
      ).not.toBeNull();
      await expectRowsEqualReplay();
    });
  });

  it("takes the stored list and its rows with its project", async () => {
    const c = client();
    c.writer.create(LIVE, actor, { kind: "folder", name: "Gone", parent: sourceRoot(MANUSCRIPT) });
    await newStore().admit({ list, accountId: ACCOUNT, update: c.send() });
    expect(await storedVersion()).not.toBeNull();
    await db.delete(projects).where(eq(projects.id, PROJECT));
    expect(await storedVersion()).toBeNull();
    expect(await db.select().from(treeNodes)).toEqual([]);
    expect(await db.select().from(treeNodeIds)).toEqual([]);
    expect(await db.select().from(draftTreeNodes).where(eq(draftTreeNodes.draftId, DRAFT))).toEqual(
      [],
    );
  });
});
