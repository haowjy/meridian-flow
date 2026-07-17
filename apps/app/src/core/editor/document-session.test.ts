/**
 * document-session tests — status derivation from local persistence + live
 * transport state.
 *
 * The indicator was historically a one-shot snapshot taken twice during
 * startup and labelled with the inverse of its true meaning. These tests
 * pin down the corrected semantics: `synced` only when the server is
 * connected & first-sync is done, `offline` whenever the socket is
 * disconnected, `access-lost` on permanent auth denial, `syncing` while in flight, and live transitions on
 * every connection-state change — never a frozen startup value.
 */
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import type { Awareness } from "y-protocols/awareness";

import type { ConnectionState } from "@/core/transport/ThreadTransport";

import {
  DocumentSession,
  type DocumentSessionSnapshot,
  type DocumentSessionTransportProvider,
  documentSessionPersistenceKey,
} from "./document-session";

type FakeTransport = DocumentSessionTransportProvider & {
  emit: (state: ConnectionState) => void;
  resolveFirstSync: () => void;
  setSynced: (synced: boolean) => void;
  destroyed: boolean;
};

function makeFakeTransport(initial: ConnectionState = { kind: "connecting", attempt: 1 }): {
  factory: (opts: { awareness: Awareness }) => FakeTransport;
  current: () => FakeTransport;
} {
  let instance: FakeTransport | null = null;
  return {
    factory: ({ awareness }) => {
      let resolveSynced!: () => void;
      const whenSynced = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });
      const listeners = new Set<(state: ConnectionState) => void>();
      let latest = initial;
      let synced = false;
      const transport: FakeTransport = {
        awareness,
        get synced() {
          return synced;
        },
        whenSynced,
        subscribeStatus(listener) {
          listeners.add(listener);
          listener(latest);
          return () => listeners.delete(listener);
        },
        destroy() {
          this.destroyed = true;
        },
        emit(state) {
          latest = state;
          for (const l of listeners) l(state);
        },
        resolveFirstSync() {
          synced = true;
          resolveSynced();
        },
        setSynced(next) {
          synced = next;
        },
        destroyed: false,
      };
      instance = transport;
      return transport;
    },
    current: () => {
      if (!instance) throw new Error("transport not created yet");
      return instance;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function track(session: DocumentSession): {
  snapshots: DocumentSessionSnapshot[];
  unsubscribe: () => void;
} {
  const snapshots: DocumentSessionSnapshot[] = [];
  const unsubscribe = session.subscribe((snap) => snapshots.push(snap));
  return { snapshots, unsubscribe };
}

describe("DocumentSession status derivation", () => {
  it("starts detached and attaches transport once without replacing its Y.Doc", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({ roomKey: "doc-detached", enableIndexedDb: false });
    const document = session.document;

    expect(session.getSnapshot()).toMatchObject({
      status: "detached",
      connectionState: null,
    });
    let flushed = false;
    void session.whenSynced().then(() => {
      flushed = true;
    });
    await flushMicrotasks();
    expect(flushed).toBe(false);

    session.attachTransport(factory);
    expect(session.document).toBe(document);
    expect(session.getSnapshot().status).toBe("syncing");
    expect(() => session.attachTransport(factory)).toThrow("Transport already attached");

    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await session.whenSynced();
    expect(flushed).toBe(true);
    expect(session.getSnapshot().status).toBe("synced");
    await session.destroy();
  });

  it("settles whenSynced when an attached session is destroyed before server sync", async () => {
    const { factory } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-server-pending",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const synced = session.whenSynced();

    await session.destroy();

    await expect(synced).resolves.toBeUndefined();
  });

  it("builds a versioned IndexedDB persistence key from COLLAB_SCHEMA_VERSION", () => {
    expect(documentSessionPersistenceKey("doc-abc")).toBe(
      `meridian:document:v${COLLAB_SCHEMA_VERSION}:doc-abc`,
    );
    expect(documentSessionPersistenceKey("branch:branch-abc:gen:1")).toBe(
      `meridian:document:v${COLLAB_SCHEMA_VERSION}:branch:branch-abc:gen:1`,
    );
  });

  it("carries parsed room identity for live and branch rooms", () => {
    const live = new DocumentSession({ roomKey: "doc-live", enableIndexedDb: false });
    expect(live.room).toEqual({ kind: "live", documentId: "doc-live" });
    expect(live.getSnapshot().roomKey).toBe("doc-live");

    const draft = new DocumentSession({ roomKey: "branch:branch-1:gen:1", enableIndexedDb: false });
    expect(draft.room).toEqual({ kind: "branch", branchId: "branch-1", generation: 1 });
    expect(draft.getSnapshot().roomKey).toBe("branch:branch-1:gen:1");

    void live.destroy();
    void draft.destroy();
  });

  it("does not mark synced from empty local load while transport first sync is pending", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    await flushMicrotasks();
    expect(session.getSnapshot().localPersistenceSynced).toBe(true);
    expect(session.getSnapshot().status).toBe("syncing");

    current().emit({ kind: "connected" });
    expect(session.getSnapshot().status).toBe("syncing");

    current().resolveFirstSync();
    await flushMicrotasks();
    expect(session.getSnapshot().status).toBe("synced");

    void session.destroy();
  });

  it("starts as syncing while local persistence is still loading", () => {
    const { factory } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    expect(session.getSnapshot().status).toBe("syncing");
    void session.destroy();
  });

  it("flips to synced once local persistence loads AND transport is connected & synced", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const { snapshots } = track(session);
    // Initial snapshot
    expect(snapshots.at(-1)?.status).toBe("syncing");

    // Transport reports connected before first sync resolves → still syncing.
    current().emit({ kind: "connected" });
    expect(snapshots.at(-1)?.status).toBe("syncing");

    // First sync resolves → synced.
    current().resolveFirstSync();
    await flushMicrotasks();
    expect(snapshots.at(-1)?.status).toBe("synced");

    void session.destroy();
  });

  it("flips to offline when the socket disconnects after first sync, and back to synced on reconnect", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const { snapshots } = track(session);

    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await flushMicrotasks();
    expect(snapshots.at(-1)?.status).toBe("synced");

    // Socket drops (e.g. browser goes offline).
    current().emit({ kind: "disconnected" });
    expect(snapshots.at(-1)?.status).toBe("offline");

    // Reconnect in progress — still not safe on the server yet.
    current().emit({ kind: "reconnecting", attempt: 1, nextRetryAt: Date.now() });
    expect(snapshots.at(-1)?.status).toBe("syncing");

    // Reconnected and (re-)synced.
    current().emit({ kind: "connected" });
    expect(snapshots.at(-1)?.status).toBe("synced");

    const statuses = snapshots.map((s) => s.status);
    expect(statuses).toContain("offline");
    expect(statuses).toContain("syncing");
    expect(statuses).toContain("synced");

    void session.destroy();
  });

  it("reports access-lost when denied before first sync completes", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    await flushMicrotasks();
    expect(session.getSnapshot().status).toBe("syncing");

    current().emit({ kind: "unauthorized", reason: "permission-denied", code: 4401 });
    expect(session.getSnapshot().status).toBe("access-lost");

    void session.destroy();
  });

  it("reports reset as access-lost so draft review exits after server room close", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "draft:draft-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    await flushMicrotasks();

    current().emit({ kind: "reset", reason: "Reset Connection", code: 4205 });

    expect(session.getSnapshot()).toMatchObject({
      status: "access-lost",
      connectionState: { kind: "reset", code: 4205 },
    });
    void session.destroy();
  });

  it("treats permanent document denial as access-lost, not offline", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const { snapshots } = track(session);

    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await flushMicrotasks();
    expect(snapshots.at(-1)?.status).toBe("synced");

    current().emit({ kind: "unauthorized", reason: "permission-denied", code: 4401 });
    expect(snapshots.at(-1)?.status).toBe("access-lost");

    void session.destroy();
  });

  it("treats degraded reconnects as syncing", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await flushMicrotasks();
    expect(session.getSnapshot().status).toBe("synced");

    current().emit({ kind: "degraded", attempt: 7, nextRetryAt: Date.now() });
    expect(session.getSnapshot().status).toBe("syncing");
    void session.destroy();
  });

  it("can suspend and restore local awareness presence without destroying the session", () => {
    const session = new DocumentSession({ roomKey: "doc-1", enableIndexedDb: false });
    const state = { user: { name: "Writer", color: "#fff" } };
    session.awareness.setLocalState(state);

    session.suspendPresence();
    expect(session.awareness.getLocalState()).toBeNull();

    session.resumePresence();
    expect(session.awareness.getLocalState()).toEqual(state);
    void session.destroy();
  });

  it("emits destroyed after teardown and unsubscribes from transport", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const before = current();
    await session.destroy();
    expect(session.getSnapshot().status).toBe("destroyed");
    // Further transport emissions must not resurrect status from destroyed.
    before.emit({ kind: "connected" });
    expect(session.getSnapshot().status).toBe("destroyed");
  });

  it("without a transport, remains detached after local persistence loads", () => {
    const session = new DocumentSession({
      roomKey: "doc-local",
      enableIndexedDb: false,
      // no transportFactory → local-only session
    });
    // With no persistence and no transport, watchSync resolves immediately.
    // Run a microtask flush so the recompute lands.
    return Promise.resolve().then(() => {
      expect(session.getSnapshot()).toMatchObject({
        status: "detached",
        localPersistenceSynced: true,
      });
      return session.destroy();
    });
  });
});
