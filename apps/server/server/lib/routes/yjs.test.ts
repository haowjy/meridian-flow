import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createDraftCoordinator } from "../../domains/collab/domain/draft-coordinator.js";
import { createDraftPullService } from "../../domains/collab/domain/draft-pulls.js";
import { readDraftContent } from "../../domains/collab/test-support/draft-store-seam.js";
import {
  MemoryDraftStore,
  memoryDraft,
  testDraftRow,
} from "../../domains/collab/test-support/memory-draft-store.js";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
} from "../../domains/file-policy/index.js";
import { createYjsRoomAccessIndex } from "../yjs-room-access.js";
import {
  admitWriterSync,
  createHocuspocus,
  createYjsGateway,
  type DraftHandshakeState,
} from "../yjs-ws-handler.js";

const documentName = "draft:draft_1:gen:3";

const payload = new Uint8Array([1, 2, 3]);

function services(stale: boolean) {
  return {
    fileAccess: {} as never,
    fileAccessChanges: createLocalFileAccessChanges(),
    liveDocuments: {
      findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
    },
    eventSink: {} as never,
    documentSync: {
      roomRemoval: vi.fn(async () => null),
      repairDocumentAuthority: vi.fn(async () => {}),
      rejectStaleDraftSyncStep1: vi.fn(async () => stale),
      admitDraftWriterUpdate: vi.fn(async () => undefined),
    } as never,
  };
}

function gatewayServices() {
  return {
    fileAccess: {} as never,
    fileAccessChanges: createLocalFileAccessChanges(),
    liveDocuments: {
      findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
    },
    eventSink: {} as never,
    documentSync: {
      bindHocuspocus: () => undefined,
      roomRemoval: async () => null,
    } as never,
  };
}

function connectionConfig() {
  return { readOnly: false, isAuthenticated: false };
}

describe("Yjs draft handshake route guard", () => {
  it("pulls live changes into a Work draft without blocking draft-room connection", async () => {
    const live = new Y.Doc({ gc: false });
    live.getText("content").insert(0, "live advanced");
    const loadedRoom = new Y.Doc({ gc: false });
    let releasePull: (() => void) | undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const store = new MemoryDraftStore([
      memoryDraft(
        testDraftRow({
          draftId: "draft_1",
          documentId: "document-1" as never,
          workId: "work-1" as never,
          generation: 3,
        }),
        new Y.Doc({ gc: false }),
      ),
    ]);
    // The pull's rewrite waits here, so the room connects before the pull commits.
    const commitRewrite = store.commitRewrite.bind(store);
    store.commitRewrite = async (rewrite) => {
      await pullBlocked;
      return commitRewrite(rewrite);
    };
    const draftCoordinator = createDraftCoordinator({
      onAppendCommitted: () => {},
      store,
      onDraftUpdate: ({ update }) => {
        Y.applyUpdate(loadedRoom, update);
      },
    });
    const draftPulls = createDraftPullService({
      outsideTransaction: (operation) => operation(),
      liveCoordinator: {
        withDocument: async (_documentId, fn) => fn(live),
        recover: async () => {},
      },
      draftCoordinator,
      drafts: {
        listActiveWorkDraftIds: async () => ["draft_1"],
        ensureThreadPeerDraft: async () => ({
          documentDraft: { draftId: "thread-peer", upstreamDraftId: "draft_1" },
          state: new Uint8Array(),
        }),
      },
    });
    const flushDraftLivePull = vi.fn(draftPulls.flushLivePull);
    const hocuspocus = createHocuspocus(
      {
        fileAccess: createAllowAllFileAccess(),
        fileAccessChanges: createLocalFileAccessChanges(),
        documentSync: {
          roomRemoval: vi.fn(async () => null),
          repairDocumentAuthority: vi.fn(async () => {}),
          bindHocuspocus: vi.fn(),
          resolveDraftHocuspocusRoom: vi.fn(async () => ({
            draftId: "draft_1",
            documentId: "document-1",
            workId: "work-1",
            generation: 3,
            schemaVersion: COLLAB_SCHEMA_VERSION,
            status: "active",
          })),
          headSchemaVersion: vi.fn(async () => null),
          flushDraftLivePull,
        } as never,
        liveDocuments: {
          findById: async () => ({
            kind: "found" as const,
            document: {} as never,
            clashesWith: [],
          }),
        },
        eventSink: { emit() {} } as never,
      },
      createYjsRoomAccessIndex(),
    );

    await expect(
      hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName,
        context: { userId: "user-1", clientSchemaVersion: COLLAB_SCHEMA_VERSION },
      } as never),
    ).resolves.toBeUndefined();
    expect(flushDraftLivePull).toHaveBeenCalledWith("document-1");
    expect(loadedRoom.getText("content").toString()).toBe("");

    releasePull?.();
    await flushDraftLivePull.mock.results[0]?.value;
    await vi.waitFor(() => {
      expect(loadedRoom.getText("content").toString()).toBe("live advanced");
    });
    const persisted = new Y.Doc({ gc: false });
    Y.applyUpdate(persisted, await readDraftContent(store, "draft_1"));
    expect(persisted.getText("content").toString()).toBe("live advanced");
  });

  it("rejects hostile draft payloads before returning them to Hocuspocus", async () => {
    const admitDraftWriterUpdate = vi.fn(async () => {
      throw new Error("reserved provenance");
    });
    const document = new Y.Doc();

    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitDraftWriterUpdate, roomRemoval: async () => null } as never,
        },
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: {
          draftSyncState: new Map([["draft_1:3", "passed"]]),
        },
      }),
    ).rejects.toMatchObject({ reason: "draft-update-admission-failed", code: 1008 });
    expect(admitDraftWriterUpdate).toHaveBeenCalledWith({
      draftId: "draft_1",
      expectedGeneration: 3,
      update: new Uint8Array([1, 2, 3]),
      origin: { type: "user", userId: "user-1" },
      document,
    });
  });

  it("waits for draft durability before returning the update to Hocuspocus", async () => {
    let commit: (() => void) | undefined;
    const admitDraftWriterUpdate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    const admission = admitWriterSync({
      services: {
        ...services(false),
        documentSync: { admitDraftWriterUpdate, roomRemoval: async () => null } as never,
      },
      documentName,
      document: new Y.Doc(),
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
      context: {
        draftSyncState: new Map([["draft_1:3", "passed"]]),
      },
    });

    await Promise.resolve();
    let returned = false;
    void admission.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    commit?.();
    await expect(admission).resolves.toBeUndefined();
    expect(returned).toBe(true);
  });

  it("rejects update-first sync messages", async () => {
    const state = new Map<string, DraftHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { draftSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "draft-stale-doc", code: 4205 });
    expect(state.get("draft_1:3")).toBe("rejected");
  });

  it("keeps a rejected room rejected when a later step1 would pass", async () => {
    const state = new Map<string, DraftHandshakeState>();
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: { draftSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "draft-stale-doc" });
    await expect(
      admitWriterSync({
        services: services(false),
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsSyncStep1,
        payload,
        userId: "user-1" as never,
        context: { draftSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "draft-stale-doc", code: 4205 });
    expect(state.get("draft_1:3")).toBe("rejected");
  });

  it("clears draft sync state through the route close handler", async () => {
    const state = new Map<string, DraftHandshakeState>([["draft_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      draftSyncState: state,
      offlineSyncUpdates: new Set<string>(),
    };

    gateway.close(connection as never, { code: 1000, reason: "test" });

    expect(handleClose).toHaveBeenCalledWith({ code: 1000, reason: "test" });
    expect(state.size).toBe(0);
  });

  it("clears draft sync state through the route error handler", async () => {
    const state = new Map<string, DraftHandshakeState>([["draft_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const gateway = createYjsGateway(gatewayServices());
    const connection = {
      hocuspocus: { handleClose },
      draftSyncState: state,
      offlineSyncUpdates: new Set<string>(),
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
      liveDocuments: {
        findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
      },
      eventSink: { emit: vi.fn() } as never,
      documentSync: {
        roomRemoval: vi.fn(async () => null),
        repairDocumentAuthority: vi.fn(async () => {}),
        bindHocuspocus: () => undefined,
        getPersistenceQueueMetrics: () => ({}),
        drainHocuspocusPersistence: () => persistenceDrain,
      } as never,
    });
    const drain = gateway.drain();
    const close = vi.fn();

    const connection = gateway.connect({
      request: new Request("https://server.localhost/ws/yjs", {
        headers: {
          "sec-websocket-protocol": formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION),
        },
      }),
      userId: "user-1" as never,
      traceId: "trace-1",
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
        new Promise<{ admitted: true }>((resolve) => {
          events.push("accept");
          commit = () => {
            events.push("journal");
            resolve({ admitted: true });
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
      expectedGeneration: 1n,
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

  it("returns a contained admission", async () => {
    const payload = new Uint8Array([0, 0]);
    const admitLiveWriterUpdate = vi.fn(async () => ({
      admitted: false as const,
    }));

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
        expectedGeneration: 1n,
      }),
    ).resolves.toEqual({ admitted: false });
  });

  it("rejects a failed admission and accepts the client's resubmitted update", async () => {
    const payload = new Uint8Array([7, 8, 9]);
    const admitLiveWriterUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("journal down"))
      .mockResolvedValueOnce({ admitted: true });
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
      expectedGeneration: 1n,
    };

    await expect(admitWriterSync(input)).rejects.toMatchObject({
      reason: "writer-journal-admission-failed",
      code: 1013,
    });
    await expect(admitWriterSync(input)).resolves.toEqual({
      admitted: true,
    });
    expect(admitLiveWriterUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("Yjs room access", () => {
  const liveRoom = "00000000-0000-4000-8000-000000000201";

  function roomServices(input: { readOnly?: boolean } = {}) {
    const allowAll = createAllowAllFileAccess();
    const documentSync = {
      roomRemoval: vi.fn(async () => null),
      repairDocumentAuthority: vi.fn(async () => {}),
      bindHocuspocus: vi.fn(),
      headSchemaVersion: vi.fn(async () => null),
      currentLiveGeneration: vi.fn(async () => 1n),
      admitLiveWriterUpdate: vi.fn(async () => ({ admitted: true })),
      resolveDraftHocuspocusRoom: vi.fn(async () => ({
        draftId: "draft_1",
        documentId: liveRoom,
        workId: "work-1",
        generation: 3,
        schemaVersion: COLLAB_SCHEMA_VERSION,
        status: "active",
      })),
      flushDraftLivePull: vi.fn(async () => undefined),
    };
    return {
      fileAccess: {
        ...allowAll,
        // An archived Work's file: readable, not editable.
        authorize: (async (principal, target, need) =>
          input.readOnly && need === "edit"
            ? archivedDenial(await allowAll.authorize(principal, target, "read"))
            : allowAll.authorize(principal, target, need)) as typeof allowAll.authorize,
      },
      fileAccessChanges: createLocalFileAccessChanges(),
      documentSync: documentSync as never,
      liveDocuments: {
        findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
      },
      eventSink: { emit() {} } as never,
      admitLiveWriterUpdate: documentSync.admitLiveWriterUpdate,
    };
  }

  function roomPeer() {
    return {
      request: new Request("https://server.localhost/ws/yjs", {
        headers: {
          "sec-websocket-protocol": formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION),
        },
      }),
      userId: "user-1" as never,
      traceId: "trace-1",
      close: vi.fn(),
      socket: { send: vi.fn(), close: vi.fn(), readyState: 1 },
    };
  }

  it("admits a read-only room and keeps its updates out of the journal", async () => {
    const services = roomServices({ readOnly: true });
    const hocuspocus = createHocuspocus(services, createYjsRoomAccessIndex());
    const context = {
      userId: "user-1",
      clientSchemaVersion: COLLAB_SCHEMA_VERSION,
      closeTransport: vi.fn(),
    };
    const config = connectionConfig();

    await hocuspocus.configuration.onConnect?.({
      documentName: liveRoom,
      context,
      connectionConfig: config,
    } as never);
    expect(config.readOnly).toBe(true);

    await expect(
      hocuspocus.configuration.beforeSync?.({
        documentName: liveRoom,
        document: new Y.Doc(),
        type: messageYjsUpdate,
        payload,
        context,
      } as never),
    ).resolves.toBeUndefined();
    expect(services.admitLiveWriterUpdate).not.toHaveBeenCalled();
  });

  it("closes a Work's draft room with 4409 when its access changes, not a manuscript room", async () => {
    const services = roomServices();
    const gateway = createYjsGateway(services);
    const handleClose = vi.fn();
    const handleConnection = vi
      .spyOn(gateway.hocuspocus, "handleConnection")
      .mockReturnValue({ handleClose } as never);
    const draftPeer = roomPeer();
    const manuscriptPeer = roomPeer();
    gateway.connect(draftPeer);
    gateway.connect(manuscriptPeer);
    const [draftContext, manuscriptContext] = handleConnection.mock.calls.map((call) => call[2]);

    for (const [room, context] of [
      [documentName, draftContext],
      [liveRoom, manuscriptContext],
    ] as const) {
      await gateway.hocuspocus.configuration.onConnect?.({
        documentName: room,
        context,
        connectionConfig: connectionConfig(),
      } as never);
    }
    await services.fileAccessChanges.publish({ workId: "work-1" as never });

    expect(draftPeer.close).toHaveBeenCalledWith(4409, "access-changed");
    expect(handleClose).toHaveBeenCalledOnce();
    expect(handleClose).toHaveBeenCalledWith({ code: 4409, reason: "access-changed" });
    expect(manuscriptPeer.close).not.toHaveBeenCalled();
  });

  it("closes a room with 4409 when its access changed before the room was registered", async () => {
    const services = roomServices();
    const allowAll = services.fileAccess.authorize;
    let archived = false;
    // The Work is archived after admission's checks, before the room hears changes.
    services.fileAccess.authorize = (async (principal, target, need) => {
      if (archived && need === "edit") {
        return archivedDenial(await allowAll(principal, target, "read"));
      }
      const decision = await allowAll(principal, target, need);
      if (need === "edit") archived = true;
      return decision;
    }) as typeof allowAll;
    const context = {
      userId: "user-1",
      clientSchemaVersion: COLLAB_SCHEMA_VERSION,
      closeTransport: vi.fn(),
      registration: { revoke: vi.fn() },
    };

    await expect(
      createHocuspocus(services, createYjsRoomAccessIndex()).configuration.onConnect?.({
        documentName: liveRoom,
        context,
        connectionConfig: connectionConfig(),
      } as never),
    ).rejects.toMatchObject({ code: 4409 });
    expect(context.closeTransport).toHaveBeenCalledWith({ code: 4409, reason: "access-changed" });
  });
});

/** An archived Work's file, as the policy refuses an edit: readable, with its facts. */
function archivedDenial(read: FileGrant | FileAccessDenied): FileAccessDenied {
  if (isFileAccessDenied(read)) return read;
  return {
    denied: true,
    target: read.facts.target,
    reason: "work_archived",
    level: "read",
    archivedWork: null,
    facts: read.facts,
    destination: read.destination,
    agentChain: null,
  };
}
