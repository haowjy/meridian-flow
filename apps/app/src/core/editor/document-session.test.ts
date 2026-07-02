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
  it("builds a versioned IndexedDB persistence key from COLLAB_SCHEMA_VERSION", () => {
    expect(documentSessionPersistenceKey("doc-abc")).toBe(
      `meridian:document:v${COLLAB_SCHEMA_VERSION}:doc-abc`,
    );
    expect(documentSessionPersistenceKey("draft:draft-abc")).toBe(
      `meridian:document:v${COLLAB_SCHEMA_VERSION}:draft:draft-abc`,
    );
  });

  it("carries parsed room identity for live and draft rooms", () => {
    const live = new DocumentSession({ roomKey: "doc-live", enableIndexedDb: false });
    expect(live.room).toEqual({ kind: "live", documentId: "doc-live" });
    expect(live.getSnapshot().roomKey).toBe("doc-live");

    const draft = new DocumentSession({ roomKey: "draft:draft-1", enableIndexedDb: false });
    expect(draft.room).toEqual({ kind: "draft", draftId: "draft-1" });
    expect(draft.getSnapshot().roomKey).toBe("draft:draft-1");

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

  it("without a transport at all, status is synced once local persistence loads", () => {
    const session = new DocumentSession({
      roomKey: "doc-local",
      enableIndexedDb: false,
      // no transportFactory → local-only session
    });
    // With no persistence and no transport, watchSync resolves immediately.
    // Run a microtask flush so the recompute lands.
    return Promise.resolve().then(() => {
      expect(session.getSnapshot().status).toBe("synced");
      return session.destroy();
    });
  });
});
