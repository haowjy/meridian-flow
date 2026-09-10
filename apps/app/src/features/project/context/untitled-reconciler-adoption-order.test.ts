import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import { UntitledReconciler, type UntitledReconcilerDeps } from "./untitled-reconciler";

it("reserves non-bindable adoption before create and preserves it on an indeterminate result", async () => {
  const order: string[] = [];
  const queued: Array<() => void> = [];
  const document = new Y.Doc();
  const fragment = document.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("writer words")]);
  fragment.insert(0, [paragraph]);
  const snapshot = {
    key: { accountId: "account", projectId: "project", documentId: "doc" },
    ref: { accountId: "account", projectId: "project", lineageHandle: "L" },
    revision: 1,
    workRevision: 1,
    phase: "local" as const,
    work: {
      workRevision: 1,
      home: { scheme: "scratch" as const, workId: "work" },
      createSettlement: { kind: "ready" as const },
      pendingSinceMs: 1,
    },
  };
  const reservation = {
    handoff: Object.freeze({}) as never,
    pending: {
      documentId: "doc",
      transitionId: "T",
      lineageHandle: "L",
      exactDatabaseName: "P",
      targetGeneration: null,
    },
  };
  const abort = vi.fn(async () => {
    order.push("abort-O");
  });
  const deps: UntitledReconcilerDeps = {
    scheduler: {
      queue: (task) => queued.push(task),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      onOnline: () => () => undefined,
    },
    newDocumentId: () => "other",
    localOwner: {
      accountId: "account",
      list: () => [snapshot],
      read: () => snapshot,
      write: vi.fn(),
      acknowledgeReconciliation: vi.fn(async () => undefined),
      acknowledgeFailureCleared: vi.fn(async () => undefined),
      acknowledgeAdoptionPublication: vi.fn(async () => undefined),
      publishAdoption: vi.fn(async () => "published" as const),
      get: () => ({
        document,
        fragmentName: "prosemirror",
        whenLocalPersistenceSynced: async () => undefined,
        waitForDurableSync: async () => undefined,
        getSnapshot: () => ({ status: "detached" }) as never,
      }),
      restore: vi.fn(),
      retain: vi.fn(),
      release: vi.fn(),
      revision: () => 1,
      prepare: async () => {
        order.push("reserve-O");
        return reservation;
      },
      abort,
      open: vi.fn(),
      remint: vi.fn(),
      abandon: vi.fn(),
      phase: () => "local",
    },
    api: {
      resolveHome: async () => ({ scheme: "scratch", workId: "work" }),
      create: async () => {
        order.push("server-create");
        throw new Error("response lost");
      },
      materialized: vi.fn(),
      confirmCreate: vi.fn(),
      move: vi.fn(),
      lookupGeneration: vi.fn(),
    },
  };
  const reconciler = new UntitledReconciler(deps);
  reconciler.start();
  queued.shift()?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual(["reserve-O", "server-create"]);
  expect(abort).not.toHaveBeenCalled();
  reconciler.dispose();
});

it("settles independent adopted sync and closed-tab publication obligations", async () => {
  const queued: Array<() => void> = [];
  const publicationAcks: string[] = [];
  const syncAcks: string[] = [];
  const snapshot = {
    key: { accountId: "account", projectId: "project", documentId: "doc" },
    ref: { accountId: "account", projectId: "project", lineageHandle: "L" },
    revision: 4,
    workRevision: 3,
    phase: "adopted" as const,
    canonicalSync: { obligationId: "sync", documentId: "doc", adoptionRevision: 2 },
    tabPublication: {
      obligationId: "publication",
      lineageHandle: "L",
      documentId: "doc",
      adoptionRevision: 2,
    },
    work: {
      workRevision: 3,
      home: { scheme: "scratch" as const, workId: "work" },
      createSettlement: {
        kind: "confirmed" as const,
        result: {
          status: "created" as const,
          documentId: "doc",
          scheme: "scratch" as const,
          path: "/doc.md",
          name: "Untitled",
          workId: "work",
        },
      },
      pendingSinceMs: 1,
    },
  };
  const deps: UntitledReconcilerDeps = {
    scheduler: {
      queue: (task) => queued.push(task),
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      onOnline: () => () => undefined,
    },
    newDocumentId: () => "unused",
    localOwner: {
      accountId: "account",
      list: () => [snapshot],
      read: () => snapshot,
      write: vi.fn(),
      acknowledgeReconciliation: vi.fn(async () => {
        syncAcks.push("sync");
      }),
      acknowledgeFailureCleared: vi.fn(async () => undefined),
      acknowledgeAdoptionPublication: vi.fn(async () => {
        publicationAcks.push("publication");
      }),
      publishAdoption: vi.fn(async () => "not-referenced" as const),
      get: () => null,
      restore: vi.fn(),
      retain: vi.fn(),
      release: vi.fn(),
      revision: () => 4,
      prepare: vi.fn(),
      abort: vi.fn(),
      open: vi.fn(
        async () =>
          ({
            kind: "opened" as const,
            admission: {
              bind: async () => ({
                session: {
                  document: new Y.Doc(),
                  fragmentName: "prosemirror",
                  whenLocalPersistenceSynced: async () => undefined,
                  waitForDurableSync: async () => undefined,
                  getSnapshot: () => ({ status: "synced" }) as never,
                },
                release: vi.fn(),
              }),
            },
          }) as never,
      ),
      remint: vi.fn(),
      abandon: vi.fn(),
      phase: () => "adopted",
    },
    api: {
      resolveHome: vi.fn(),
      create: vi.fn(),
      materialized: vi.fn(),
      confirmCreate: vi.fn(),
      move: vi.fn(),
      lookupGeneration: vi.fn(),
    },
  };
  const reconciler = new UntitledReconciler(deps);
  reconciler.start();
  queued.shift()?.();
  await vi.waitFor(() => {
    expect(publicationAcks).toEqual(["publication"]);
    expect(syncAcks).toEqual(["sync"]);
  });
  reconciler.dispose();
});
