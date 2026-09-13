/** Local peer convergence and the persistence/teardown boundary, without a server. */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import * as Y from "yjs";
import { LocalDocumentPeers } from "./local-document-peers";

const sessions: Array<{
  document: Y.Doc;
  persistence: IndexeddbPersistence;
  peers?: LocalDocumentPeers;
}> = [];
const errors: unknown[] = [];

async function local(name: string, isolated = false) {
  if (isolated) vi.stubGlobal("indexedDB", new IDBFactory());
  const document = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, document);
  const session = { document, persistence, peers: undefined as LocalDocumentPeers | undefined };
  sessions.push(session);
  await persistence.whenSynced;
  return session;
}

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document: new EventTarget() }));
  vi.stubGlobal("reportError", (error: unknown) => errors.push(error));
});

function connect(session: Awaited<ReturnType<typeof local>>) {
  session.peers = new LocalDocumentPeers(session.document, session.persistence);
  return session.peers;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.peers?.drain();
    await session.persistence.destroy();
    session.document.destroy();
  }
  vi.unstubAllGlobals();
  expect(errors.splice(0)).toEqual([]);
});

it("exchanges both peers' prior edits and live updates without an IndexedDB or server shortcut", async () => {
  const name = `peers-${crypto.randomUUID()}`;
  const left = await local(name, true);
  const right = await local(name, true);
  left.document.getMap("writing").set("left", "offline left");
  right.document.getMap("writing").set("right", "offline right");
  connect(left);
  connect(right);
  const expected = { left: "offline left", right: "offline right" };
  await vi.waitFor(() => {
    expect(left.document.getMap("writing").toJSON()).toEqual(expected);
    expect(right.document.getMap("writing").toJSON()).toEqual(expected);
  });
  left.document.getMap("writing").delete("left");
  right.document.getMap("writing").set("right", "continued");
  await vi.waitFor(() => {
    expect(left.document.getMap("writing").toJSON()).toEqual({ right: "continued" });
    expect(right.document.getMap("writing").toJSON()).toEqual({ right: "continued" });
  });
  const otherIncarnation = await local(`${name}-new-generation`, true);
  connect(otherIncarnation);
  await otherIncarnation.peers?.catchUp();
  expect(otherIncarnation.document.getMap("writing").size).toBe(0);
});

it("recovers a departed sender's missed updates while the library compacts its durable log", async () => {
  const name = `catchup-${crypto.randomUUID()}`;
  const receiver = await local(name);
  const peers = connect(receiver);
  await peers.catchUp();
  const sender = await local(name);
  sender.document.getMap("writing").set("missed", "recoverable writing");
  await Promise.all([peers.catchUp(), storeState(sender.persistence)]);
  await sender.persistence.destroy();
  await peers.catchUp();
  expect(receiver.document.getMap("writing").toJSON()).toEqual({ missed: "recoverable writing" });
});

it("discards a pending replay after stop and drains its transaction before provider teardown", async () => {
  const session = await local(`fenced-${crypto.randomUUID()}`);
  const peers = connect(session);
  await peers.catchUp();
  const database = session.persistence.db;
  if (!database) throw new Error("Missing persistence database");
  const writer = new Y.Doc();
  writer.getMap("writing").set("late", "do not apply after fence");
  const transaction = database.transaction("updates", "readwrite");
  const updates = transaction.objectStore("updates");
  updates.add(Y.encodeStateAsUpdate(writer));
  writer.destroy();
  let release = false;
  const keepAlive = () => {
    const request = updates.count();
    request.onsuccess = () => {
      if (!release) keepAlive();
    };
  };
  keepAlive();
  const replay = peers.catchUp();
  await Promise.resolve();
  peers.stop();
  let drained = false;
  const drain = peers.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release = true;
  await Promise.all([replay, drain]);
  expect(session.document.getMap("writing").size).toBe(0);
  const restored = await local(session.persistence.name);
  expect(restored.document.getMap("writing").toJSON()).toEqual({
    late: "do not apply after fence",
  });
});
