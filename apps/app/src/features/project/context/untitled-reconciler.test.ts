/** Behavioral coverage for the registry-driven untitled reconciliation loop. */

import type { CreateUntitledContextDocumentResult } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocumentSessionSnapshot } from "@/core/editor/document-session";
import {
  type PendingUntitled,
  UntitledReconciler,
  type UntitledReconcilerDeps,
  untitledDocumentIsEmpty,
  untitledHomeUri,
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
      rename: vi.fn(async () => ({ status: "renamed" as const })),
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
        return session;
      },
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
  let waitForDurableSync = vi.fn(async () => {});
  let flushLocalPersistence = vi.fn(async () => {});
  return {
    document,
    fragmentName: "prosemirror" as const,
    whenLocalPersistenceSynced: vi.fn(async () => {}),
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
    setDurableWait(wait: () => Promise<void>) {
      waitForDurableSync = vi.fn(wait);
    },
    setPersistenceFlush(wait: () => Promise<void>) {
      flushLocalPersistence = vi.fn(wait);
    },
  };
}

function storedEntries(values: Map<string, string>): PendingUntitled[] {
  return JSON.parse(values.get("meridian:pending-untitled") ?? "[]") as PendingUntitled[];
}

describe("untitled reconciler lifecycle", () => {
  it("starts once, schedules persisted work, and tears down listeners and retries", async () => {
    const h = harness();
    h.values.set(
      "meridian:pending-untitled",
      JSON.stringify([{ documentId: "doc-1", projectId: "project-1" }]),
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

    expect(storedEntries(h.values)).toEqual([{ documentId: "doc-1", projectId: "project-1" }]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1);
  });
});

describe("untitled reconciliation durability", () => {
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
      status: "already-exists",
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

  it("retains terminally denied words while continuing with other entries", async () => {
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

    expect(storedEntries(h.values).map((entry) => entry.documentId)).toEqual(["denied"]);
    expect(h.cleared).toEqual([]);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.timers).toHaveLength(1);
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

describe("queued rename receipts", () => {
  it("records a conflict receipt when the queued rename 409s after materialization", async () => {
    const h = harness();
    (h.deps.api.rename as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "conflict" as const,
    });
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    reconciler.queueRename("doc-1", "taken.md");

    await h.runQueue();

    // Materialization itself succeeded: the entry drains and the document is
    // no longer device-only — only the rename receipt reports the failure.
    expect(storedEntries(h.values)).toEqual([]);
    expect(reconciler.has("doc-1")).toBe(false);
    expect(reconciler.queuedRenameFailure("doc-1")).toEqual({
      kind: "conflict",
      name: "taken.md",
      scheme: "scratch",
      path: "/taken.md",
    });

    reconciler.clearQueuedRenameFailure("doc-1");
    expect(reconciler.queuedRenameFailure("doc-1")).toBeNull();
  });

  it("replaces a stale failure when a newer name is queued", async () => {
    const h = harness();
    (h.deps.api.rename as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "conflict" as const,
    });
    const reconciler = new UntitledReconciler(h.deps);
    reconciler.start();
    reconciler.append({ documentId: "doc-1", projectId: "project-1", home: HOME });
    reconciler.queueRename("doc-1", "taken.md");
    await h.runQueue();
    expect(reconciler.queuedRenameFailure("doc-1")?.kind).toBe("conflict");

    reconciler.queueRename("doc-1", "free-name.md");
    expect(reconciler.queuedRenameFailure("doc-1")).toBeNull();
  });
});

describe("untitled document decisions", () => {
  it("resolves the default work scratch root through one seam", () => {
    expect(untitledHomeUri("project-1", "work-1")).toEqual(HOME);
    expect(untitledHomeUri("project-1", null)).toBeNull();
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
