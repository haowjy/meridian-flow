import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsSyncStep2, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createBranchCoordinator } from "../../domains/collab/domain/branch-coordinator.js";
import { createBranchPullService } from "../../domains/collab/domain/branch-pulls.js";
import {
  admitWriterSync,
  type BranchHandshakeState,
  createHocuspocus,
  createYjsGateway,
} from "../yjs-ws-handler.js";

const documentName = "branch:branch_1:gen:3";

const payload = new Uint8Array([1, 2, 3]);

function services(stale: boolean) {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    documentSync: {
      rejectStaleBranchSyncStep1: vi.fn(async () => stale),
    } as never,
  };
}

function updateWithText(text: string): Uint8Array {
  const document = new Y.Doc({ gc: false });
  document.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(document);
}

function gatewayServices() {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    documentSync: { bindHocuspocus: () => undefined } as never,
  };
}

describe("Yjs branch handshake route guard", () => {
  it("pulls live changes into a Work draft without blocking branch-room connection", async () => {
    const live = new Y.Doc({ gc: false });
    live.getText("content").insert(0, "live advanced");
    const loadedRoom = new Y.Doc({ gc: false });
    let storedState = Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));
    let releasePull: (() => void) | undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const branchCoordinator = createBranchCoordinator({
      store: {
        getBranch: async () => ({
          branchId: "branch_1",
          documentId: "document-1" as never,
          kind: "work_draft",
          upstreamBranchId: null,
          workId: "work-1" as never,
          threadId: null,
          pushPolicy: "manual",
          status: "active",
          generation: 3,
          state: storedState,
          stateVector: Y.encodeStateVectorFromUpdate(storedState),
          discardedStateVector: null,
          schemaVersion: COLLAB_SCHEMA_VERSION,
        }),
        async updateBranchSnapshot(input) {
          await pullBlocked;
          storedState = input.state;
          return true;
        },
        deferUntilCommit: () => false,
      },
      onBranchUpdate: ({ update }) => {
        Y.applyUpdate(loadedRoom, update);
      },
    });
    const branchPulls = createBranchPullService({
      liveCoordinator: {
        withDocument: async (_documentId, fn) => fn(live),
        recover: async () => {},
      },
      branchCoordinator,
      branches: {
        listActiveWorkDraftBranchIds: async () => ["branch_1"],
        ensureWorkDraftBranch: async () => ({ branchId: "branch_1" }),
        ensureThreadPeerBranch: async () => ({ branchId: "thread-peer" }),
      },
    });
    const flushBranchLivePull = vi.fn(branchPulls.flushLivePull);
    const hocuspocus = createHocuspocus({
      documentAccess: {
        canAccessDocument: vi.fn(async () => true),
      } as never,
      documentSync: {
        bindHocuspocus: vi.fn(),
        resolveBranchHocuspocusRoom: vi.fn(async () => ({
          branchId: "branch_1",
          documentId: "document-1",
          generation: 3,
          status: "active",
        })),
        flushBranchLivePull,
      } as never,
      eventSink: { emit() {} } as never,
    });

    await expect(
      hocuspocus.configuration.onConnect?.({
        documentName,
        context: { userId: "user-1" },
      } as never),
    ).resolves.toBeUndefined();
    expect(flushBranchLivePull).toHaveBeenCalledWith("document-1");
    expect(loadedRoom.getText("content").toString()).toBe("");

    releasePull?.();
    await flushBranchLivePull.mock.results[0]?.value;
    await vi.waitFor(() => {
      expect(loadedRoom.getText("content").toString()).toBe("live advanced");
    });
    const persisted = new Y.Doc({ gc: false });
    Y.applyUpdate(persisted, storedState);
    expect(persisted.getText("content").toString()).toBe("live advanced");
  });

  it("rejects client-authored branch updates before returning them to Hocuspocus", async () => {
    const closeTransport = vi.fn();
    const document = new Y.Doc();

    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload: updateWithText("writer edit"),
        userId: "user-1" as never,
        closeTransport,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
        },
      }),
    ).rejects.toMatchObject({ reason: "branch-review-read-only", code: 1008 });
    expect(closeTransport).toHaveBeenCalledWith({
      code: 1008,
      reason: "branch-review-read-only",
    });
  });

  it("allows contained branch sync acknowledgements", async () => {
    const document = new Y.Doc({ gc: false });
    document.getText("content").insert(0, "server draft");

    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document,
        syncType: messageYjsSyncStep2,
        payload: Y.encodeStateAsUpdate(document),
        userId: "user-1" as never,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a deletion for content the branch has not received yet", async () => {
    const source = new Y.Doc({ gc: false });
    const text = source.getText("content");
    text.insert(0, "future insertion");
    const insertion = Y.encodeStateAsUpdate(source);
    const afterInsert = Y.encodeStateVector(source);
    text.delete(0, text.length);
    const deletionOnly = Y.encodeStateAsUpdate(source, afterInsert);
    const document = new Y.Doc({ gc: false });

    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload: deletionOnly,
        userId: "user-1" as never,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
        },
      }),
    ).rejects.toMatchObject({ reason: "branch-review-read-only", code: 1008 });

    Y.applyUpdate(document, insertion);
    expect(document.getText("content").toString()).toBe("future insertion");
  });

  it("rejects update-first sync messages", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("keeps a rejected room rejected when a later step1 would pass", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc" });
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsSyncStep1,
        payload,
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("allows a fresh client to pass step1 but not mutate the review room", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await admitWriterSync({
      services: services(false),
      documentName,
      document: new Y.Doc(),
      syncType: messageYjsSyncStep1,
      payload,
      userId: "user-1" as never,
      context: { branchSyncState: state },
    });
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload: updateWithText("writer edit"),
        userId: "user-1" as never,
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-review-read-only", code: 1008 });
    expect(state.get("branch_1:3")).toBe("passed");
  });

  it("clears branch sync state through the route close handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      branchSyncState: state,
      offlineSyncUpdates: new Set<string>(),
      liveGenerations: new Map<string, bigint>(),
    };

    gateway.close(connection as never, { code: 1000, reason: "test" });

    expect(handleClose).toHaveBeenCalledWith({ code: 1000, reason: "test" });
    expect(state.size).toBe(0);
  });

  it("clears branch sync state through the route error handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      branchSyncState: state,
      offlineSyncUpdates: new Set<string>(),
      liveGenerations: new Map<string, bigint>(),
    };

    gateway.error(connection as never);

    expect(handleClose).toHaveBeenCalledWith({ code: 1011, reason: "error" });
    expect(state.size).toBe(0);
  });

  it("stops connection admission synchronously when drain starts", async () => {
    let finishPersistenceDrain: (() => void) | undefined;
    const persistenceDrain = new Promise<void>((resolve) => {
      finishPersistenceDrain = resolve;
    });
    const gateway = createYjsGateway({
      ...gatewayServices(),
      eventSink: { emit: vi.fn() } as never,
      documentSync: {
        bindHocuspocus: () => undefined,
        getPersistenceQueueMetrics: () => ({}),
        drainHocuspocusPersistence: () => persistenceDrain,
      } as never,
    });
    const drain = gateway.drain();
    const close = vi.fn();

    const connection = gateway.connect({
      request: new Request("https://server.localhost/ws/yjs"),
      userId: "user-1" as never,
      close,
      socket: {
        send: vi.fn(),
        close: vi.fn(),
        readyState: 1,
      },
    });

    expect(connection).toBeUndefined();
    expect(close).toHaveBeenCalledWith(1012, "server-shutdown");
    finishPersistenceDrain?.();
    await drain;
  });
});

describe("Yjs live writer admission", () => {
  it("accepts a non-empty system update only after journal, then applies, broadcasts, and acks", async () => {
    const client = new Y.Doc({ gc: false });
    client.getText("content").insert(0, "non-empty system update");
    const payload = Y.encodeStateAsUpdate(client);
    const server = new Y.Doc({ gc: false });
    const events: string[] = [];
    let commit: (() => void) | undefined;
    const admitLiveWriterUpdate = vi.fn(
      () =>
        new Promise<{ admitted: true; joinedSettlement: boolean }>((resolve) => {
          events.push("accept");
          commit = () => {
            events.push("journal");
            resolve({ admitted: true, joinedSettlement: true });
          };
        }),
    );
    const admission = admitWriterSync({
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      document: server,
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
    });

    await Promise.resolve();
    expect(admitLiveWriterUpdate).toHaveBeenCalledWith({
      documentId: "document-1",
      document: server,
      update: payload,
      origin: { type: "user", userId: "user-1" },
      expectedGeneration: 1n,
    });
    let returnedToHocuspocus = false;
    void admission.then(() => {
      Y.applyUpdate(server, payload);
      events.push("apply", "broadcast", "ack");
      returnedToHocuspocus = true;
    });
    await Promise.resolve();
    expect(returnedToHocuspocus).toBe(false);
    commit?.();
    await admission;
    expect(returnedToHocuspocus).toBe(true);
    expect(server.getText("content").toString()).toBe("non-empty system update");
    expect(events).toEqual(["accept", "journal", "apply", "broadcast", "ack"]);
  });

  it("does not send an empty update to PostgreSQL bytea admission", async () => {
    const admitLiveWriterUpdate = vi.fn();
    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitLiveWriterUpdate } as never,
        },
        documentName: "document-1",
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload: new Uint8Array(),
        userId: "user-1" as never,
      }),
    ).resolves.toBeUndefined();
    expect(admitLiveWriterUpdate).not.toHaveBeenCalled();
  });

  it("returns a contained admission without closing the transport", async () => {
    const payload = new Uint8Array([0, 0]);
    const admitLiveWriterUpdate = vi.fn(async () => ({
      admitted: false as const,
      joinedSettlement: false as const,
    }));
    const closeTransport = vi.fn();

    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitLiveWriterUpdate } as never,
        },
        documentName: "document-1",
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
      }),
    ).resolves.toEqual({ admitted: false, joinedSettlement: false });
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("rejects a failed admission and accepts the client's resubmitted update", async () => {
    const payload = new Uint8Array([7, 8, 9]);
    const admitLiveWriterUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("journal down"))
      .mockResolvedValueOnce({ admitted: true, joinedSettlement: false });
    const closeTransport = vi.fn();
    const input = {
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      document: new Y.Doc(),
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
      closeTransport,
    };

    await expect(admitWriterSync(input)).rejects.toMatchObject({
      reason: "writer-journal-admission-failed",
      code: 1013,
    });
    expect(closeTransport).toHaveBeenCalledWith({
      code: 1013,
      reason: "writer-journal-admission-failed",
    });
    await expect(admitWriterSync(input)).resolves.toEqual({
      admitted: true,
      joinedSettlement: false,
    });
    expect(admitLiveWriterUpdate).toHaveBeenCalledTimes(2);
  });
});
