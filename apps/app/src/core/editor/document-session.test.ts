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
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "@/test-support/memory-storage";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
  type DocumentSessionSnapshot,
  type DocumentSessionTransportProvider,
} from "./document-session";
import { clientSchemaReloadGuardKey } from "./schema-fence";

type FakeTransport = DocumentSessionTransportProvider & {
  emit: (state: DocumentSessionConnectionState) => void;
  resolveFirstSync: () => void;
  setAcknowledged: (acknowledged: boolean) => void;
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
      const acknowledgementListeners = new Set<(acknowledged: boolean) => void>();
      let acknowledged = false;
      const listeners = new Set<(state: DocumentSessionConnectionState) => void>();
      const changeListeners = new Set<(message: ChangeEventWsMessage) => void>();
      let latest = initial;
      let synced = false;
      const transport: FakeTransport = {
        get synced() {
          return synced;
        },
        whenSynced,
        subscribeServerAcknowledgement(listener) {
          acknowledgementListeners.add(listener);
          listener(acknowledged);
          return () => acknowledgementListeners.delete(listener);
        },
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
        setAcknowledged(next) {
          acknowledged = next;
          for (const l of acknowledgementListeners) l(next);
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

describe("DocumentSession status derivation", () => {
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
      persistence: { kind: "none" },
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
      persistence: { kind: "none" },
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
      persistence: { kind: "none" },
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

  it("surfaces a stale document head without reloading or raising a schema fence", async () => {
    const { reload } = installBrowserReloadHarness();
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-stale",
      persistence: { kind: "none" },
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

  it("starts detached and attaches transport once without replacing its Y.Doc", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({ roomKey: "doc-detached", persistence: { kind: "none" } });
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

  it("reports access-lost when denied before first sync completes", async () => {
    const { factory, current } = makeFakeTransport();
    const session = new DocumentSession({
      roomKey: "doc-1",
      persistence: { kind: "none" },
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
      persistence: { kind: "none" },
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

  it("holds field writes off the wire until the last nested suspension resumes, including an emptied field", () => {
    const session = new DocumentSession({ roomKey: "doc-1", persistence: { kind: "none" } });
    session.presence.setField("user", { name: "Writer" });
    session.presence.setField("imageUploads", [{ token: "old" }]);

    session.suspendPresence();
    session.suspendPresence();
    // The upload landed while the writer was inside inline review. Nothing is on
    // the wire, and the correction still has to be true when they come out.
    session.presence.setField("imageUploads", []);
    expect(session.awareness.getLocalState()).toBeNull();
    session.resumePresence();
    expect(session.awareness.getLocalState()).toBeNull();

    session.resumePresence();

    expect(session.awareness.getLocalState()).toEqual({
      user: { name: "Writer" },
      imageUploads: [],
    });
    void session.destroy();
  });

  it("raises one orthogonal schema fence and suspends presence", () => {
    const persistSchemaFence = vi.fn();
    const session = new DocumentSession({
      roomKey: "doc-fenced",
      persistence: { kind: "none" },
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

  it("joins one destroy attempt and retries only the rejected transport stage", async () => {
    let rejectTransport!: (error: Error) => void;
    const transportDestroy = new Promise<void>((_resolve, reject) => {
      rejectTransport = reject;
    });
    const destroyTransport = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(transportDestroy)
      .mockResolvedValue();
    const session = new DocumentSession({
      roomKey: "doc-destroy-rejection",
      persistence: { kind: "none" },
      transportFactory: () => ({
        synced: false,
        subscribeStatus: () => () => undefined,
        destroy: destroyTransport,
      }),
    });
    const awarenessDestroy = vi.spyOn(session.awareness, "destroy");
    const documentDestroy = vi.spyOn(session.document, "destroy");

    const first = session.destroy();
    const joined = session.destroy();
    expect(joined).toBe(first);
    expect(session.getSnapshot().status).toBe("destroyed");
    expect(awarenessDestroy).not.toHaveBeenCalled();

    const failure = new Error("provider destroy failed");
    rejectTransport(failure);
    await expect(first).rejects.toBe(failure);
    expect(awarenessDestroy).toHaveBeenCalled();
    expect(documentDestroy).toHaveBeenCalledOnce();
    await expect(session.destroy()).resolves.toBeUndefined();
    expect(destroyTransport).toHaveBeenCalledTimes(2);
    expect(documentDestroy).toHaveBeenCalledOnce();
  });
});
