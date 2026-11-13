/**
 * A tree list's room, end to end: the real client (`@meridian/tree-list-sync`) over the real
 * gateway and store, on postgres, joined by a socket that carries frames in memory.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a refusal closes the socket with its own code, and the client reconnects or rebuilds by it
 * - a long history travels to the server in parts of a few hundred records
 * - a commit on one process reaches the rooms of every other through Postgres NOTIFY
 */

import { WS_CLOSE } from "@meridian/contracts/protocol";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import { contextSources, projects, treeNodes, users } from "@meridian/database/schema";
import {
  LIVE,
  listRecords,
  recordsOf,
  sourceRoot,
  type TreeRecord,
  TreeWriter,
} from "@meridian/project-tree";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { connectTreeList, type ListCopy, type ListSyncState } from "@meridian/tree-list-sync";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createDrizzleJournal } from "../domains/collab/adapters/drizzle-journal.js";
import {
  closeDatabase,
  createTestDatabase,
  DOCUMENT_RUNTIME_RESET_TABLES,
  deleteDrizzleRows,
} from "../domains/collab/test-support/collab-postgres-harness.js";
import { createDrizzleTreeListStore } from "../domains/context/adapters/drizzle-tree-list-store.js";
import type { TreeListStore } from "../domains/context/ports/tree-list-store.js";
import { createLocalFileAccessChanges } from "../domains/file-policy/index.js";
import { createInMemoryEventSink } from "../domains/observability/index.js";
import { createYjsGateway, type YjsGateway } from "./yjs-ws-handler.js";

const ACCOUNT = "00000000-0000-4000-8000-000000000b01";
const STRANGER = "00000000-0000-4000-8000-000000000b02";
const PROJECT = "00000000-0000-4000-8000-000000000b03";
const MANUSCRIPT = "00000000-0000-4000-8000-000000000b04";
const UNFILED = "00000000-0000-4000-8000-000000000b05";
const actor = `user:${ACCOUNT}`;
const ROOM = `tree:project:${PROJECT}`;

const until = (condition: () => boolean | Promise<boolean>, what: string, ms = 15_000) =>
  vi.waitFor(
    async () => {
      if (!(await condition())) throw new Error(`waiting for ${what}`);
    },
    { timeout: ms, interval: 20 },
  );

/** What the browser sees of its copy: a fresh Yjs client id each time it is replaced. */
function memoryCopy(): ListCopy & { doc: Y.Doc } {
  let carried: readonly TreeRecord[] = [];
  const make = () => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 1000 + Math.floor(Math.random() * 1e9);
    return doc;
  };
  const copy = {
    doc: make(),
    async replace() {
      carried = recordsOf(copy.doc).toArray();
      copy.doc = make();
    },
    carried: () => carried,
    async settleCarried() {
      carried = [];
    },
  };
  return copy;
}

describe("a tree list's room (postgres)", () => {
  const db = createTestDatabase();
  const journal = createDrizzleJournal(db);
  const gateways: YjsGateway[] = [];
  const connections: Array<{ destroy(): void }> = [];
  const unlisten: Array<Promise<{ unlisten(): Promise<void> }>> = [];

  /** A server process: its own store (so its own copy of the list) and its own gateway. */
  function serverProcess() {
    const store = createDrizzleTreeListStore({ db, journal });
    unlisten.push(store.listen());
    const changes = createLocalFileAccessChanges();
    const gateway = createYjsGateway({
      liveDocuments: { findById: async () => ({ kind: "not_found" }) },
      fileAccess: {},
      fileAccessChanges: changes,
      documentSync: {
        bindHocuspocus: () => undefined,
        getPersistenceQueueMetrics: () => ({}),
        drainHocuspocusPersistence: async () => undefined,
      },
      eventSink: createInMemoryEventSink(),
      treeLists: store,
    } as never);
    gateways.push(gateway);
    return { store, gateway, changes };
  }

  /** Frames from the server to a client, by what they carry, for the tests that count parts. */
  type Wire = { toClient: number[] };

  /** A browser tab: a copy and a connection to `server` as `userId`. */
  function browser(
    server: { gateway: YjsGateway },
    options: { userId?: string; room?: string; copy?: ListCopy & { doc: Y.Doc } } = {},
  ) {
    const copy = options.copy ?? memoryCopy();
    const wire: Wire = { toClient: [] };
    const states: ListSyncState[] = [];
    const rejected: unknown[] = [];

    class BridgeSocket extends EventTarget {
      readyState = 0;
      binaryType = "arraybuffer";
      identifier = 0;
      private connection: ReturnType<YjsGateway["connect"]>;
      constructor() {
        super();
        const closeFromServer = (code?: number, reason?: string) => {
          if (this.readyState === 3) return;
          this.readyState = 3;
          server.gateway.close(this.connection, { code, reason });
          this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
        };
        this.connection = server.gateway.connect({
          request: new Request("https://server.localhost/ws/yjs", {
            headers: {
              "sec-websocket-protocol": formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION),
            },
          }),
          userId: (options.userId ?? ACCOUNT) as never,
          traceId: "trace",
          close: closeFromServer,
          socket: {
            send: (data) => {
              const bytes =
                typeof data === "string"
                  ? new Uint8Array()
                  : new Uint8Array(data as ArrayBufferLike);
              wire.toClient.push(bytes.byteLength);
              queueMicrotask(() =>
                this.dispatchEvent(Object.assign(new Event("message"), { data: bytes.buffer })),
              );
            },
            close: closeFromServer,
            readyState: 1,
          },
        });
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
        });
      }
      send(data: Uint8Array) {
        if (this.readyState === 1) server.gateway.message(this.connection, data);
      }
      close() {
        this.readyState = 3;
        server.gateway.close(this.connection, { code: 1000, reason: "close" });
      }
    }

    const connection = connectTreeList({
      roomName: options.room ?? ROOM,
      url: "ws://bridge",
      WebSocketPolyfill: BridgeSocket,
      copy,
      onState: (state) => states.push(state),
      onRejected: (records) => rejected.push(...records),
    });
    connections.push(connection);
    return {
      copy,
      wire,
      states,
      rejected,
      get state() {
        return states.at(-1);
      },
      /** A client's own records, authored as the app will: through the package's writer. */
      writer: () => new TreeWriter(copy.doc),
      ids: () =>
        recordsOf(copy.doc)
          .toArray()
          .map((record) => record.id),
      destroy: () => connection.destroy(),
    };
  }

  beforeEach(async () => {
    await deleteDrizzleRows(db, DOCUMENT_RUNTIME_RESET_TABLES);
    await db
      .insert(users)
      .values([
        conformanceUserValues(ACCOUNT, "tree-room"),
        conformanceUserValues(STRANGER, "tree-room-stranger"),
      ]);
    await db
      .insert(projects)
      .values({ id: PROJECT, userId: ACCOUNT, name: "Serial", slug: "serial" });
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
  });
  afterEach(async () => {
    for (const connection of connections.splice(0)) connection.destroy();
    for (const gateway of gateways.splice(0)) await gateway.drain();
    for (const listening of unlisten.splice(0)) await (await listening).unlisten();
  });
  afterAll(() => closeDatabase(db));

  const createDocument = (copy: { doc: Y.Doc }, name: string, parent = sourceRoot(MANUSCRIPT)) =>
    new TreeWriter(copy.doc).create(LIVE, actor, {
      kind: "document",
      name,
      parent,
      filetype: "markdown",
    });

  /** The journal's list as a fresh copy would replay it. */
  async function journalRecords(server: { store: TreeListStore }) {
    const list = { kind: "project", projectId: PROJECT } as const;
    const access = await server.store.open({ list, accountId: ACCOUNT });
    const read = await server.store.readSince({ listId: access?.listId ?? "", afterSeq: 0 });
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, read.update);
    return listRecords(doc);
  }

  it("brings several browsers' copies to the same list, with the rows equal to the replay", async () => {
    const server = serverProcess();
    const tabs = [browser(server), browser(server), browser(server)];
    await until(() => tabs.every((tab) => tab.state === "synced"), "every copy synced");

    await Promise.all(
      tabs.map(async (tab, at) => {
        for (let n = 0; n < 4; n++) {
          createDocument(tab.copy, `chapter ${at}-${n}`);
          await Promise.resolve();
        }
      }),
    );
    await until(() => tabs.every((tab) => tab.ids().length === 12), "twelve records in every copy");
    const reference = [...(tabs[0]?.ids().sort() ?? [])];
    for (const tab of tabs) expect([...tab.ids()].sort()).toEqual(reference);
    const journaled = (await journalRecords(server)).map((record) => record.id).sort();
    expect(journaled).toEqual(reference);

    const rows = await db.select().from(treeNodes);
    expect(rows.map((row) => row.name).sort()).toEqual(
      tabs.flatMap((_, at) => [0, 1, 2, 3].map((n) => `chapter ${at}-${n}`)).sort(),
    );
  });

  it("closes a hostile update's connection, rebuilds the client and loses nothing honest", async () => {
    const server = serverProcess();
    const tab = browser(server);
    await until(() => tab.state === "synced", "synced");
    const first = createDocument(tab.copy, "first");
    await until(async () => (await journalRecords(server)).length === 1, "first admitted");

    // A forged record between two honest ones, each in its own update, as three frames.
    const forged: TreeRecord = {
      ...(recordsOf(tab.copy.doc).get(0) as TreeRecord),
      id: crypto.randomUUID(),
      node: crypto.randomUUID(),
      actor: `user:${STRANGER}`,
    };
    const staleDoc = tab.copy.doc;
    createDocument(tab.copy, "second");
    staleDoc.transact(() => recordsOf(staleDoc).push([forged]));
    createDocument(tab.copy, "third");

    await until(() => tab.states.includes("rebuilding"), "the rebuild");
    await until(
      () => tab.copy.doc !== staleDoc && tab.state === "synced",
      "the rebuilt copy to sync",
    );
    await until(
      async () => (await journalRecords(server)).length === 3 && tab.rejected.length === 1,
      "the honest records admitted and the forged one given up on",
    );
    const names = (await db.select().from(treeNodes)).map((row) => row.name).sort();
    expect(names).toEqual(["first", "second", "third"]);
    expect(await journalRecords(server)).not.toContainEqual(
      expect.objectContaining({ id: forged.id }),
    );
    expect(first.id).toBeTruthy();
    // The rebuilt copy has a Yjs client id of its own.
    expect(tab.copy.doc.clientID).not.toBe(staleDoc.clientID);
    expect(tab.states).toContain("rebuilding");
  }, 60_000);

  it("sends a long offline session up in parts, and a new client takes the whole history", async () => {
    const server = serverProcess();
    const admissions: number[] = [];
    const admit = server.store.admit.bind(server.store);
    server.store.admit = async (input) => {
      admissions.push(input.update.byteLength);
      return admit(input);
    };

    // 700 records made with no connection: one create and 699 renames, one merged run of items.
    const offline = memoryCopy();
    const writer = new TreeWriter(offline.doc);
    const made = writer.create(LIVE, actor, {
      kind: "document",
      name: "draft 0",
      parent: sourceRoot(MANUSCRIPT),
      filetype: "markdown",
    });
    for (let n = 1; n < 700; n++) writer.rename(LIVE, actor, made.node, `draft ${n}`);

    const tab = browser(server, { copy: offline });
    await until(
      async () => (await journalRecords(server)).length === 700,
      "all 700 records admitted",
      60_000,
    );
    expect(admissions.filter((bytes) => bytes > 0).length).toBeGreaterThanOrEqual(3);
    expect((await db.select().from(treeNodes))[0]?.name).toBe("draft 699");
    expect(tab.state).not.toBe("denied");

    // A new tab takes the whole history.
    const fresh = browser(server);
    await until(
      () => fresh.ids().length === 700 && fresh.state === "synced",
      "700 in the new tab",
      30_000,
    );
  }, 120_000);

  it("shows one server process's records to an idle tab on another, with no exchange from that tab", async () => {
    const one = serverProcess();
    const other = serverProcess();
    const tabOne = browser(one);
    const tabOther = browser(other);
    await until(() => tabOne.state === "synced" && tabOther.state === "synced", "both synced");

    const committedAt = Date.now();
    createDocument(tabOne.copy, "from process one");
    await until(() => tabOther.ids().length === 1, "the record on the other process");
    const rows = await db.select().from(treeNodes).where(eq(treeNodes.contextSourceId, MANUSCRIPT));
    expect(rows.map((row) => row.name)).toEqual(["from process one"]);
  });

  it("reconnects a client whose admission failed, and loses nothing", async () => {
    const server = serverProcess();
    const tab = browser(server);
    await until(() => tab.state === "synced", "synced");
    const admit = server.store.admit.bind(server.store);
    let failures = 1;
    server.store.admit = async (input) => {
      if (failures-- > 0) throw new Error("the database dropped the connection");
      return admit(input);
    };
    createDocument(tab.copy, "after a fault");
    await until(() => tab.states.includes("offline"), "the socket closed with a real code");
    await until(
      async () => (await journalRecords(server)).length === 1 && tab.state === "synced",
      "reconnected and the record admitted",
    );
  });

  it("closes the connections of a project that is deleted", async () => {
    const server = serverProcess();
    const reader = browser(server);
    await until(() => reader.state === "synced", "synced");
    await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, PROJECT));
    // The deletion publishes this change in the application; the gateway closes by the room's key.
    await server.changes.publish({ projectId: PROJECT });
    await until(() => reader.state === "denied", "denied after the project went");
  });

  it("keeps a read-only connection's updates out of the store", async () => {
    // A project with no source the account can write: the owner may read the list, not write it.
    const READ_ONLY = "00000000-0000-4000-8000-000000000b06";
    await db
      .insert(projects)
      .values({ id: READ_ONLY, userId: ACCOUNT, name: "Empty", slug: "empty" });
    const server = serverProcess();
    const admit = vi.spyOn(server.store, "admit");
    const tab = browser(server, { room: `tree:project:${READ_ONLY}` });
    await until(() => tab.state === "read-only", "synced, read-only");
    const framesBefore = tab.wire.toClient.length;
    createDocument(tab.copy, "never admitted", sourceRoot(UNFILED));
    // The room answers the dropped frame with its SyncStatus(false): nothing was admitted or stored.
    await until(() => tab.wire.toClient.length > framesBefore, "the room's answer");
    expect(admit).not.toHaveBeenCalled();
    expect(await db.select().from(treeNodes)).toHaveLength(0);
  });

  it("refuses a connection that is not the list's account", async () => {
    const server = serverProcess();
    const stranger = browser(server, { userId: STRANGER });
    await until(() => stranger.state === "denied", "denied");
    expect(WS_CLOSE.PERMISSION_DENIED.code).toBe(4403);
    expect(stranger.ids()).toHaveLength(0);
  });
});
