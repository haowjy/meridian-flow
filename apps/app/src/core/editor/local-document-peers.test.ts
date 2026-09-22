/** Same-profile document peers share ephemeral awareness as well as durable Yjs content. */
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { LocalDocumentPeers } from "./local-document-peers";
import { createLocalPresence, type LocalPresence } from "./local-presence";

type LocalPeer = {
  document: Y.Doc;
  persistence: IndexeddbPersistence;
  awareness: Awareness;
  presence: LocalPresence;
  peers: LocalDocumentPeers;
};

const sessions: LocalPeer[] = [];
const errors: unknown[] = [];

async function connect(name: string): Promise<LocalPeer> {
  const document = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, document);
  const awareness = new Awareness(document);
  const presence = createLocalPresence(awareness);
  await persistence.whenSynced;
  const peers = new LocalDocumentPeers(document, persistence, awareness);
  const session = { document, persistence, awareness, presence, peers };
  sessions.push(session);
  return session;
}

beforeEach(() => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document: new EventTarget() }));
  vi.stubGlobal("reportError", (error: unknown) => errors.push(error));
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.peers.drain();
    await session.persistence.destroy();
    session.presence.release();
    session.awareness.destroy();
    session.document.destroy();
  }
  vi.unstubAllGlobals();
  expect(errors.splice(0)).toEqual([]);
});

it("exchanges live awareness between same-incarnation browser peers", async () => {
  const name = `awareness-${crypto.randomUUID()}`;
  const left = await connect(name);
  const right = await connect(name);

  left.presence.setField("user", { name: "Left" });
  left.presence.setField("cursor", { anchor: 1, head: 2 });

  await vi.waitFor(() => {
    expect(right.awareness.getStates().get(left.awareness.clientID)).toMatchObject({
      user: { name: "Left" },
      cursor: { anchor: 1, head: 2 },
    });
  });

  right.presence.setField("user", { name: "Right" });
  right.presence.setField("cursor", { anchor: 3, head: 4 });
  await vi.waitFor(() => {
    expect(left.awareness.getStates().get(right.awareness.clientID)).toMatchObject({
      user: { name: "Right" },
      cursor: { anchor: 3, head: 4 },
    });
  });

  await left.peers.drain();
  await vi.waitFor(() => {
    expect(right.awareness.getStates().has(left.awareness.clientID)).toBe(false);
  });
});
