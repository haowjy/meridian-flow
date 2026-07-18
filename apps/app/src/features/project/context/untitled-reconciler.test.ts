/** Behavioral coverage for the registry-driven untitled reconciliation loop. */

import type { CreateUntitledContextDocumentResult } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocumentSessionSnapshot } from "@/core/editor/document-session";
import {
  type PendingUntitled,
  type ReconciliationRecord,
  resolveUntitledHome,
  UntitledReconciler,
  type UntitledReconcilerDeps,
  untitledDocumentIsEmpty,
} from "./untitled-reconciler";

const HOME = { scheme: "scratch", workId: "work-1" } as const;

function contentDocument(text = "words"): Y.Doc {
  const document = new Y.Doc();
  if (text) {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText(text)]);
    document.getXmlFragment("prosemirror").insert(0, [paragraph]);
  }
  return document;
}

function harness() {
  const values = new Map<string, string>();
  const queued: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const online = new Set<() => void>();
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const cleared: string[] = [];
  const create = vi.fn(
    async (
      entry: PendingUntitled & { home: typeof HOME },
    ): Promise<CreateUntitledContextDocumentResult> => ({
      status: "created",
      documentId: entry.documentId,
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
    }),
  );
  const resolveHome = vi.fn(async () => HOME as typeof HOME | null);
  const exists = vi.fn(async () => false);
  let nextId = "replacement";

  const deps: UntitledReconcilerDeps = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    scheduler: {
      queue: (task) => queued.push(task),
      setTimer: (task) => {
        timers.push(task);
        return task;
      },
      clearTimer: (timer) => {
        const index = timers.indexOf(timer as () => void);
        if (index >= 0) timers.splice(index, 1);
      },
      onOnline: (task) => {
        online.add(task);
        return () => online.delete(task);
      },
    },
    api: {
      resolveHome,
      create,
      serverDocumentExists: exists,
      move: vi.fn(async () => ({
        status: "moved" as const,
        scheme: "manuscript" as const,
        path: "Act 1/Opening.md",
        name: "Opening.md",
      })),
    },
    sessions: {
      getDetached(id) {
        let session = sessions.get(id);
        if (!session) {
          session = fakeSession(contentDocument());
          sessions.set(id, session);
        }
        return session;
      },
      attachDetached(id) {
        const session = sessions.get(id);
        if (!session) throw new Error(`missing session ${id}`);
        if (session.getSnapshot().status === "detached") session.setStatus("synced");
        return session;
      },
      restartUnavailableRoom: vi.fn(async (id: string) => {
        const session = sessions.get(id);
        if (session?.getSnapshot().status !== "access-lost") return false;
        session.setStatus("detached");
        return true;
      }),
      retain: vi.fn(),
      release: vi.fn(),
      async destroyRoom(id, options) {
        if (options?.clearPersistence) cleared.push(id);
        sessions.delete(id);
      },
    },
    newDocumentId: () => nextId,
  };

  async function runQueue(): Promise<void> {
    queued.shift()?.();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  }

  return {
    deps,
    values,
    queued,
    timers,
    online,
    sessions,
    cleared,
    create,
    resolveHome,
    exists,
    runQueue,
    setNextId(id: string) {
      nextId = id;
    },
  };
}

function fakeSession(document: Y.Doc) {
  let status: DocumentSessionSnapshot["status"] = "synced";
  let whenLocalPersistenceSynced = vi.fn(async () => {});
  let waitForDurableSync = vi.fn(async () => {});
  let flushLocalPersistence = vi.fn(async () => {});
  return {
    document,
    fragmentName: "prosemirror" as const,
    get whenLocalPersistenceSynced() {
      return whenLocalPersistenceSynced;
    },
    getSnapshot: () => ({ status }) as DocumentSessionSnapshot,
    get waitForDurableSync() {
      return waitForDurableSync;
    },
    get flushLocalPersistence() {
      return flushLocalPersistence;
    },
    setStatus(next: DocumentSessionSnapshot["status"]) {
      status = next;
    },
    setLocalWait(wait: () => Promise<void>) {
      whenLocalPersistenceSynced = vi.fn(wait);
    },
    setDurableWait(wait: () => Promise<void>) {
      waitForDurableSync = vi.fn(wait);
    },
    setPersistenceFlush(wait: () => Promise<void>) {
      flushLocalPersistence = vi.fn(wait);
    },
  };
}

function storedEntries(values: Map<string, string>): ReconciliationRecord[] {
  return JSON.parse(values.get("meridian:pending-untitled") ?? "[]") as ReconciliationRecord[];
}

describe("untitled reconciler lifecycle", () => {
  it("starts once, schedules persisted work, and tears down listeners and retries", async () => {
    const h = harness();
    h.values.set(
      "meridian:pending-untitled",
      JSON.stringify([
        {
          documentId: "doc-1",
          materialization: {
            phase: "pending",
            entry: { documentId: "doc-1", projectId: "project-1" },
          },
          pendingSinceMs: 0,
        },
      ]),
    );
    h.resolveHome.mockResolvedValue(null);
    const reconciler = new UntitledReconciler(h.deps);

    reconciler.start();
    reconciler.start();
    expect(h.online.size).toBe(1);
    expect(h.queued).toHaveLength(1);
    await h.runQueue();
    expect(h.timers).toHaveLength(1);

    reconciler.dispose();
    expect(h.online.size).toBe(0);
    expect(h.timers).toHaveLength(0);
  });

  it("retains unresolved-home entries for a later retry", async () => {
    const h = harness();
    h.resolveHome.mockResolvedValue(null);
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1" });

    await h.runQueue();

    expect(storedEntries(h.values)).toEqual([
      expect.objectContaining({
        documentId: "doc-1",
        materialization: {
          phase: "pending",
          entry: { documentId: "doc-1", projectId: "project-1" },
        },
      }),
    ]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1);
  });
});

describe("untitled reconciliation durability", () => {
  it("preserves identity queued while local persistence is loading", async () => {
    const h = harness();
    const session = fakeSession(contentDocument(""));
    let finishLocalSync!: () => void;
    session.setLocalWait(
      () =>
        new Promise<void>((resolve) => {
          finishLocalSync = resolve;
        }),
    );
    h.sessions.set("doc-1", session);
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });

    h.queued.shift()?.();
    await Promise.resolve();
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
    finishLocalSync();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(h.create).toHaveBeenCalledOnce();
    expect(h.deps.api.move).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Untitled",
      expect.objectContaining({ name: "Opening.md" }),
    );
    expect(h.cleared).toEqual([]);
  });

  it("preserves the newest identity queued while an older move is pending", async () => {
    const h = harness();
    h.create
      .mockResolvedValueOnce({
        status: "created",
        documentId: "doc-1",
        scheme: "scratch",
        path: "/Untitled",
        name: "Untitled",
      })
      .mockResolvedValueOnce({
        status: "already-materialized",
        documentId: "doc-1",
        scheme: "manuscript",
        path: "/Act 1/First.md",
        name: "First.md",
      });
    let finishFirstMove!: (result: {
      status: "moved";
      scheme: "manuscript";
      path: string;
      name: string;
    }) => void;
    (h.deps.api.move as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstMove = resolve;
        }),
    );
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1", home: HOME },
      {
        name: "First.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );

    h.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1", home: HOME },
      {
        name: "Latest.md",
        destination: { scheme: "manuscript", folderPath: "/Act 2" },
      },
    );
    finishFirstMove({
      status: "moved",
      scheme: "manuscript",
      path: "Act 1/First.md",
      name: "First.md",
    });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(storedEntries(h.values)[0]?.desiredIdentity).toEqual({
      name: "Latest.md",
      destination: { scheme: "manuscript", folderPath: "/Act 2" },
    });
    await h.runQueue();
    expect(h.deps.api.move).toHaveBeenLastCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Act 1/First.md",
      expect.objectContaining({ name: "Latest.md" }),
    );
    expect(storedEntries(h.values)).toEqual([]);
  });

  it("does not drain identity work queued while durable sync is pending", async () => {
    const h = harness();
    const session = fakeSession(contentDocument());
    let finishDurableSync!: () => void;
    session.setDurableWait(
      () =>
        new Promise<void>((resolve) => {
          finishDurableSync = resolve;
        }),
    );
    h.sessions.set("doc-1", session);
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });

    h.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1", home: HOME },
      {
        name: "Latest.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
    finishDurableSync();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(storedEntries(h.values)[0]?.desiredIdentity?.name).toBe("Latest.md");
    await h.runQueue();
    expect(h.deps.api.move).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Untitled",
      expect.objectContaining({ name: "Latest.md" }),
    );
  });

  it("materializes an explicitly named empty document and keeps it pending across reload", async () => {
    const h = harness();
    h.sessions.set("doc-1", fakeSession(contentDocument("")));
    const first = new UntitledReconciler(h.deps);
    first.start();
    first.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
    first.dispose();

    const restored = new UntitledReconciler(h.deps);
    restored.rehydrate();
    expect(restored.has("doc-1")).toBe(true);
    restored.start();
    await h.runQueue(); // stale callback from the disposed instance
    await h.runQueue();

    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1", projectId: "project-1", home: HOME }),
    );
    expect(h.deps.api.move).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Untitled",
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
    expect(storedEntries(h.values)).toEqual([]);
    expect(h.cleared).toEqual([]);
  });

  it("restores an explicit desired identity after a reload", async () => {
    const h = harness();
    const first = new UntitledReconciler(h.deps);
    first.start();
    first.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    first.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
    first.dispose();

    expect(storedEntries(h.values)[0]?.desiredIdentity).toEqual({
      name: "Opening.md",
      destination: { scheme: "manuscript", folderPath: "/Act 1" },
    });

    const restored = new UntitledReconciler(h.deps);
    restored.start();
    await h.runQueue(); // stale callback from the disposed instance
    await h.runQueue();
    expect(h.deps.api.move).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Untitled",
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "/Act 1" },
      },
    );
  });

  it("clears an empty local room only after the server confirms no row", async () => {
    const h = harness();
    h.sessions.set("doc-1", fakeSession(contentDocument("")));
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });

    await h.runQueue();

    expect(h.exists).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.cleared).toEqual(["doc-1"]);
    expect(storedEntries(h.values)).toEqual([]);
  });

  it("attaches and durably flushes empty history when a server row exists", async () => {
    const h = harness();
    h.exists.mockResolvedValue(true);
    const session = fakeSession(contentDocument(""));
    h.sessions.set("doc-1", session);
    h.create.mockResolvedValue({
      status: "already-materialized",
      documentId: "doc-1",
      scheme: "scratch",
      path: "/Untitled",
      name: "Untitled",
    });
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });

    await h.runQueue();

    expect(session.waitForDurableSync).toHaveBeenCalledOnce();
    expect(h.cleared).toEqual([]);
    expect(storedEntries(h.values)).toEqual([]);
  });

  it("restarts a pre-materialization denial and continues with other entries", async () => {
    const h = harness();
    const denied = fakeSession(contentDocument("first"));
    denied.setStatus("access-lost");
    h.sessions.set("denied", denied);
    h.sessions.set("healthy", fakeSession(contentDocument("second")));
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "denied", projectId: "project-1", home: HOME });
    reconciler.append({ documentId: "healthy", projectId: "project-1", home: HOME });

    await h.runQueue();

    expect(storedEntries(h.values)).toEqual([]);
    expect(h.cleared).toEqual([]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.deps.sessions.restartUnavailableRoom).toHaveBeenCalledWith("denied");
  });

  it("restores a failure receipt without restoring the device-only warning", async () => {
    const h = harness();
    (h.deps.api.move as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "conflict" as const,
      collision: { scheme: "scratch" as const, path: "taken.md", workId: "work-1" },
    });
    const first = new UntitledReconciler(h.deps);
    first.start();
    first.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    first.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "taken.md",
        destination: { scheme: "scratch", folderPath: "/", workId: "work-1" },
      },
    );
    await h.runQueue();
    first.dispose();

    const restored = new UntitledReconciler(h.deps);
    restored.start();
    expect(restored.queuedIdentityFailure("doc-1")).toMatchObject({
      kind: "conflict",
      name: "taken.md",
    });
    expect(restored.pendingSince("doc-1")).toBeNull();
  });

  it("persists a reminted room only after its IndexedDB transaction completes", async () => {
    const h = harness();
    h.create.mockResolvedValueOnce({ status: "conflict" });
    h.sessions.set("original", fakeSession(contentDocument("irreplaceable words")));
    let finishFlush!: () => void;
    const replacement = fakeSession(contentDocument(""));
    replacement.setPersistenceFlush(
      () =>
        new Promise<void>((resolve) => {
          finishFlush = resolve;
        }),
    );
    h.sessions.set("replacement", replacement);
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "original", projectId: "project-1", home: HOME });

    h.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(storedEntries(h.values)[0]?.documentId).toBe("original");

    finishFlush();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(storedEntries(h.values)[0]?.documentId).toBe("replacement");
    expect(untitledDocumentIsEmpty(replacement.document.getXmlFragment("prosemirror"))).toBe(false);
  });
});

describe("queued identity receipts", () => {
  it("records a conflict receipt when the queued identity conflicts after materialization", async () => {
    const h = harness();
    (h.deps.api.move as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "conflict" as const,
      collision: { scheme: "scratch" as const, path: "taken.md", workId: "work-1" },
    });
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "taken.md",
        destination: { scheme: "scratch", folderPath: "/", workId: "work-1" },
      },
    );

    await h.runQueue();

    // Materialization itself succeeded: the entry drains and the document is
    // no longer device-only — only the identity receipt reports the failure.
    expect(storedEntries(h.values)).toEqual([
      expect.objectContaining({
        documentId: "doc-1",
        materialization: { phase: "synced" },
        pendingSinceMs: null,
      }),
    ]);
    expect(reconciler.has("doc-1")).toBe(false);
    expect(reconciler.pendingSince("doc-1")).toBeNull();
    expect(reconciler.queuedIdentityFailure("doc-1")).toEqual({
      kind: "conflict",
      name: "taken.md",
      scheme: "scratch",
      path: "/taken.md",
      workId: "work-1",
    });

    reconciler.clearQueuedIdentityFailure("doc-1");
    expect(reconciler.queuedIdentityFailure("doc-1")).toBeNull();
  });

  it("replaces a stale failure when a newer name is queued", async () => {
    const h = harness();
    (h.deps.api.move as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "conflict" as const,
      collision: { scheme: "scratch" as const, path: "taken.md", workId: "work-1" },
    });
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "taken.md",
        destination: { scheme: "scratch", folderPath: "/", workId: "work-1" },
      },
    );
    await h.runQueue();
    expect(reconciler.queuedIdentityFailure("doc-1")?.kind).toBe("conflict");

    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "free-name.md",
        destination: { scheme: "scratch", folderPath: "/", workId: "work-1" },
      },
    );
    expect(reconciler.queuedIdentityFailure("doc-1")).toBeNull();
  });

  it("applies a queued placement through the move seam and reports its conflicts", async () => {
    const h = harness();
    const onIdentityCommitted = vi.fn();
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.registerCandidate("doc-1", {
      onReminted: vi.fn(),
      onMaterialized: vi.fn(),
      onIdentityCommitted,
    });
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    reconciler.queueIdentity(
      { documentId: "doc-1", projectId: "project-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "Act 1" },
      },
    );
    await h.runQueue();

    expect(h.deps.api.move).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: "doc-1" }),
      "/Untitled",
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "Act 1" },
      },
    );
    expect(onIdentityCommitted).toHaveBeenCalledWith({
      status: "moved",
      scheme: "manuscript",
      path: "/Act 1/Opening.md",
      name: "Opening.md",
    });
    expect(reconciler.queuedIdentityFailure("doc-1")).toBeNull();

    // Conflict path: the canonical locator lands as a receipt.
    (h.deps.api.move as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "conflict" as const,
      collision: { scheme: "manuscript" as const, path: "Act 1/Opening.md" },
    });
    reconciler.append({ documentId: "doc-2", projectId: "project-1", home: HOME });
    reconciler.queueIdentity(
      { documentId: "doc-2", projectId: "project-1" },
      {
        name: "Opening.md",
        destination: { scheme: "manuscript", folderPath: "Act 1" },
      },
    );
    await h.runQueue();
    expect(reconciler.queuedIdentityFailure("doc-2")).toEqual({
      kind: "conflict",
      name: "Opening.md",
      scheme: "manuscript",
      path: "/Act 1/Opening.md",
    });
  });
});

describe("untitled document decisions", () => {
  it("resolves the default work scratch root through one seam", () => {
    expect(resolveUntitledHome("work-1")).toEqual(HOME);
    expect(resolveUntitledHome(null)).toBeNull();
  });

  it("treats structural paragraphs as empty and atoms as content", () => {
    const document = contentDocument("");
    const fragment = document.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("paragraph")]);
    expect(untitledDocumentIsEmpty(fragment)).toBe(true);
    fragment.delete(0, 1);
    fragment.insert(0, [new Y.XmlElement("figure")]);
    expect(untitledDocumentIsEmpty(fragment)).toBe(false);
  });
});
