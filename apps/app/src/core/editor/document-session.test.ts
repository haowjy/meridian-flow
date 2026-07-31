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

import { type ChangeEventWsMessage, WS_CLOSE } from "@meridian/contracts/protocol";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "@/test-support/memory-storage";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
  type DocumentSessionSnapshot,
  type DocumentSessionTransportProvider,
  deleteStaleVersionedIndexedDb,
  documentSessionPersistenceKey,
} from "./document-session";
import { clientSchemaReloadGuardKey } from "./schema-fence";
import type { SchemaRepairEvent } from "./schema-repair-witness";

type FakeTransport = DocumentSessionTransportProvider & {
  emit: (state: DocumentSessionConnectionState) => void;
  resolveFirstSync: () => void;
  resolveDurableSync: () => void;
  setSynced: (synced: boolean) => void;
  emitChange: (message: ChangeEventWsMessage) => void;
  destroyed: boolean;
};

function makeFakeTransport(
  initial: DocumentSessionConnectionState = { kind: "connecting", attempt: 1 },
): {
  factory: () => FakeTransport;
  current: () => FakeTransport;
} {
  let instance: FakeTransport | null = null;
  return {
    factory: () => {
      let resolveSynced!: () => void;
      const whenSynced = new Promise<void>((resolve) => {
        resolveSynced = resolve;
      });
      let resolveDurableSynced!: () => void;
      const whenDurablySynced = new Promise<void>((resolve) => {
        resolveDurableSynced = resolve;
      });
      const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
      const changeListeners = new Set<(message: ChangeEventWsMessage) => void>();
      let latest = initial;
      let synced = false;
      const transport: FakeTransport = {
        get synced() {
          return synced;
        },
        whenSynced,
        whenDurablySynced,
        subscribeStatus(listener) {
          listeners.add(listener);
          listener(latest);
          return () => listeners.delete(listener);
        },
        subscribeChangeEvents(listener) {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
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
        resolveDurableSync() {
          resolveDurableSynced();
        },
        setSynced(next) {
          synced = next;
        },
        emitChange(message) {
          for (const listener of changeListeners) listener(message);
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

function installBrowserReloadHarness(reload = vi.fn()) {
  const storage = memoryStorage();
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("location", { reload });
  return { storage, reload };
}

afterEach(() => vi.unstubAllGlobals());

function changeEvent(
  documentId: string,
  admittedByUserId: string | null,
  projectionRevision = 1,
): ChangeEventWsMessage {
  return {
    type: "change_event",
    documentId,
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    changes: [
      {
        admittedByUserId,
        changeId: "change-1",
        kind: "delete",
        navigation: { kind: "unavailable", reason: "test" },
        swept: false,
        excerpt: null,
        pureDeletionOffset: null,
      },
    ],
    truncated: false,
  };
}

describe("DocumentSession status derivation", () => {
  it("appends schema repair verdicts to the session snapshot and emits each change", async () => {
    const session = new DocumentSession({
      roomKey: "doc-schema-repairs",
      enableIndexedDb: false,
    });
    const { snapshots, unsubscribe } = track(session);
    const first = {
      phase: "open",
      detectedAt: "2026-07-28T12:00:00.000Z",
      deletedNodeTypes: ["sidebar"],
      deletedClockCount: 12,
      removedText: "lost words",
    } satisfies SchemaRepairEvent;
    const second = {
      phase: "live",
      detectedAt: "2026-07-28T12:01:00.000Z",
      deletedNodeTypes: [],
      deletedClockCount: 3,
    } satisfies SchemaRepairEvent;

    session.reportSchemaRepair(first);
    session.reportSchemaRepair(second);

    expect(session.getSnapshot().schemaRepairs).toEqual([first, second]);
    expect(snapshots.at(-2)?.schemaRepairs).toEqual([first]);
    expect(snapshots.at(-1)?.schemaRepairs).toEqual([first, second]);
    unsubscribe();
    await session.destroy();
  });

  it("writes the loop guard before silently reloading, then fences a repeated refusal", () => {
    const guardKey = clientSchemaReloadGuardKey("doc-superseded");
    let storage!: Storage;
    const reload = vi.fn(() => {
      expect(storage.getItem(guardKey)).toBe("1");
    });
    ({ storage } = installBrowserReloadHarness(reload));
    const firstTransport = makeFakeTransport();
    const firstSession = new DocumentSession({
      roomKey: "doc-superseded",
      enableIndexedDb: false,
      transportFactory: firstTransport.factory,
    });

    firstTransport.current().emit({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(firstSession.getSnapshot().schemaFence).toBeNull();
    expect(storage.getItem(guardKey)).toBe("1");

    const secondTransport = makeFakeTransport();
    const secondSession = new DocumentSession({
      roomKey: "doc-superseded",
      enableIndexedDb: false,
      transportFactory: secondTransport.factory,
    });
    secondTransport.current().emit({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });

    expect(reload).toHaveBeenCalledOnce();
    expect(secondSession.getSnapshot().schemaFence).toEqual({
      reason: "client-superseded",
    });
    void firstSession.destroy();
    void secondSession.destroy();
  });

  it("falls through to the client-superseded fence when session storage is blocked", () => {
    const reload = vi.fn();
    const { storage } = installBrowserReloadHarness(reload);
    storage.setItem = () => {
      throw new Error("blocked");
    };
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-storage-blocked",
      enableIndexedDb: false,
      transportFactory: factory,
    });

    current().emit({
      kind: "reset",
      reason: "client-schema-superseded",
      code: 4406,
    });

    expect(reload).not.toHaveBeenCalled();
    expect(session.getSnapshot().schemaFence).toEqual({
      reason: "client-superseded",
    });
    void session.destroy();
  });

  it("clears the superseded-client reload guard after a successful document sync", async () => {
    const { storage } = installBrowserReloadHarness();
    const guardKey = clientSchemaReloadGuardKey("doc-recovered");
    storage.setItem(guardKey, "1");
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-recovered",
      enableIndexedDb: false,
      transportFactory: factory,
    });

    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await session.whenSynced();
    await flushMicrotasks();

    expect(storage.getItem(guardKey)).toBeNull();
    await session.destroy();
  });

  it("surfaces a stale document head without reloading or raising a schema fence", async () => {
    const { reload } = installBrowserReloadHarness();
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-stale",
      enableIndexedDb: false,
      transportFactory: factory,
    });

    current().emit({ kind: "reset", reason: "document-schema-stale", code: 4407 });
    await flushMicrotasks();

    expect(session.getSnapshot()).toMatchObject({
      status: "access-lost",
      connectionState: { kind: "reset", reason: "document-schema-stale", code: 4407 },
      schemaFence: null,
    });
    expect(reload).not.toHaveBeenCalled();
    void session.destroy();
  });

  it("routes live-room change events into the session sidecar with self-suppression", async () => {
    const liveTransport = makeFakeTransport();
    const live = new DocumentSession({
      roomKey: "doc-markers",
      enableIndexedDb: false,
      ownUserId: "me",
      transportFactory: liveTransport.factory,
    });
    liveTransport.current().emitChange(changeEvent("doc-markers", "me"));
    expect(live.markerStore.getSnapshot()).toHaveLength(0);
    liveTransport.current().emitChange(changeEvent("doc-markers", null, 2));
    expect(live.markerStore.getSnapshot().map((marker) => marker.changeId)).toEqual(["change-1"]);
    await live.destroy();

    const branchTransport = makeFakeTransport();
    const branch = new DocumentSession({
      roomKey: "branch:branch-1:gen:1",
      enableIndexedDb: false,
      ownUserId: "me",
      transportFactory: branchTransport.factory,
    });
    branchTransport.current().emitChange(changeEvent("branch-1", null));
    expect(branch.markerStore.getSnapshot()).toHaveLength(0);
    await branch.destroy();
  });

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

  it("waits for the server update acknowledgement after initial sync", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-durable",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    current().emit({ kind: "connected" });
    current().resolveFirstSync();
    await session.whenSynced();

    let durable = false;
    void session.waitForDurableSync().then(() => {
      durable = true;
    });
    await flushMicrotasks();
    expect(durable).toBe(false);

    current().resolveDurableSync();
    await session.waitForDurableSync();
    expect(durable).toBe(true);
    await session.destroy();
  });

  it("settles the durable wait on terminal denial", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-denied",
      enableIndexedDb: false,
      transportFactory: factory,
    });
    const durable = session.waitForDurableSync();

    current().emit({ kind: "unauthorized", reason: "expired", code: 4401 });

    await expect(durable).resolves.toBeUndefined();
    await session.destroy();
  });

  it("builds a major.minor-versioned IndexedDB persistence key", () => {
    expect(documentSessionPersistenceKey("doc-abc")).toBe(
      `meridian:document:${collabSchemaKeyTag()}:doc-abc`,
    );
    expect(documentSessionPersistenceKey("branch:branch-abc:gen:1")).toBe(
      `meridian:document:${collabSchemaKeyTag()}:branch:branch-abc:gen:1`,
    );
  });

  it("deletes lower and legacy IndexedDB versions while preserving the patch-stable tag", async () => {
    const deleteDatabase = vi.fn();
    vi.stubGlobal("indexedDB", {
      databases: vi.fn(async () => [
        { name: "meridian:document:v0.0:doc-abc" },
        { name: "meridian:document:v0.1:doc-abc" },
        { name: "meridian:document:v0.2:doc-abc" },
        { name: "meridian:document:v4:doc-abc" },
        { name: "meridian:document:v0.1.0:doc-abc" },
        { name: "meridian:document:v0.0:other-document" },
      ]),
      deleteDatabase,
    });

    deleteStaleVersionedIndexedDb("doc-abc", { major: 0, minor: 1, patch: 9 });
    await flushMicrotasks();

    expect(deleteDatabase.mock.calls.map(([name]) => name)).toEqual([
      "meridian:document:v0.0:doc-abc",
      "meridian:document:v4:doc-abc",
      "meridian:document:v0.1.0:doc-abc",
    ]);
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
    expect(snapshots.at(-1)?.status).toBe("syncing");

    // Transport reports connected before first sync resolves → still syncing.
    current().emit({ kind: "connected" });
    expect(snapshots.at(-1)?.status).toBe("syncing");

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

    current().emit({ kind: "disconnected" });
    expect(snapshots.at(-1)?.status).toBe("offline");

    // Reconnect in progress — still not safe on the server yet.
    current().emit({ kind: "reconnecting", attempt: 1, nextRetryAt: Date.now() });
    expect(snapshots.at(-1)?.status).toBe("syncing");

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

    current().emit({
      kind: "reset",
      reason: WS_CLOSE.BRANCH_STALE.reason,
      code: WS_CLOSE.BRANCH_STALE.code,
    });

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
    session.presence.setField("user", { name: "Writer", color: "#fff" });

    session.suspendPresence();
    expect(session.awareness.getLocalState()).toBeNull();

    session.resumePresence();
    expect(session.awareness.getLocalState()).toEqual({
      user: { name: "Writer", color: "#fff" },
    });
    void session.destroy();
  });

  it("publishes a field emptied while presence was suspended", () => {
    const session = new DocumentSession({ roomKey: "doc-1", enableIndexedDb: false });
    session.presence.setField("user", { name: "Writer" });
    session.presence.setField("imageUploads", [{ token: "old" }]);

    session.suspendPresence();
    // The upload landed while the writer was inside inline review. Nothing is on
    // the wire, and the correction still has to be true when they come out.
    session.presence.setField("imageUploads", []);
    expect(session.awareness.getLocalState()).toBeNull();
    session.resumePresence();

    expect(session.awareness.getLocalState()).toEqual({
      user: { name: "Writer" },
      imageUploads: [],
    });
    void session.destroy();
  });

  it("publishes a field first written while presence was suspended", () => {
    const session = new DocumentSession({ roomKey: "doc-1", enableIndexedDb: false });
    session.presence.setField("user", { name: "Writer" });

    session.suspendPresence();
    session.presence.setField("imageUploads", [{ token: "new" }]);
    session.resumePresence();

    expect(session.awareness.getLocalState()).toEqual({
      user: { name: "Writer" },
      imageUploads: [{ token: "new" }],
    });
    void session.destroy();
  });

  it("resumes only when the last of two suspensions lets go", () => {
    const session = new DocumentSession({ roomKey: "doc-1", enableIndexedDb: false });
    session.presence.setField("user", { name: "Writer" });

    session.suspendPresence();
    session.suspendPresence();
    session.presence.setField("imageUploads", [{ token: "nested" }]);
    session.resumePresence();
    expect(session.awareness.getLocalState()).toBeNull();

    session.resumePresence();

    expect(session.awareness.getLocalState()).toEqual({
      user: { name: "Writer" },
      imageUploads: [{ token: "nested" }],
    });
    void session.destroy();
  });

  it("raises one orthogonal schema fence and suspends presence", () => {
    const persistSchemaFence = vi.fn();
    const session = new DocumentSession({
      roomKey: "doc-fenced",
      enableIndexedDb: false,
      persistSchemaFence,
    });
    session.presence.setField("user", { name: "Writer" });
    const { snapshots } = track(session);

    session.raiseSchemaFence({ reason: "client-superseded" });
    session.raiseSchemaFence({ reason: "client-superseded" });

    expect(session.getSnapshot()).toMatchObject({
      status: "detached",
      schemaFence: { reason: "client-superseded" },
    });
    expect(session.awareness.getLocalState()).toBeNull();
    expect(snapshots.at(-1)?.schemaFence).toEqual({
      reason: "client-superseded",
    });
    expect(snapshots.filter((snapshot) => snapshot.schemaFence)).toHaveLength(1);
    expect(persistSchemaFence).toHaveBeenCalledOnce();
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
