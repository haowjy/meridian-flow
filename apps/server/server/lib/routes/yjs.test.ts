/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  COLLAB_SCHEMA_VERSION,
  type CollabSchemaVersion,
  formatCollabSchemaSubprotocol,
} from "@meridian/prosemirror-schema";
import { describe as __mergedSuite, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { createBranchCoordinator } from "../../domains/collab/domain/branch-coordinator.js";
import { createBranchPullService } from "../../domains/collab/domain/branch-pulls.js";
import { DocumentSchemaMajorMismatchError } from "../../domains/collab/index.js";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
} from "../../domains/file-policy/index.js";
import { createInMemoryEventSink } from "../../domains/observability/index.js";
import { createYjsRoomAccessIndex } from "../yjs-room-access.js";
import {
  admitWriterSync,
  type BranchHandshakeState,
  clientSchemaVersionFromRequest,
  createHocuspocus,
  createYjsGateway,
} from "../yjs-ws-handler.js";

__mergedSuite("yjs.test.ts", () => {
  // Merged from apps/server/server/lib/routes/yjs.test.ts.
  const documentName = "branch:branch_1:gen:3";

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
        rejectStaleBranchSyncStep1: vi.fn(async () => stale),
        admitBranchWriterUpdate: vi.fn(async () => undefined),
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
      documentSync: { bindHocuspocus: () => undefined } as never,
    };
  }

  function connectionConfig() {
    return { readOnly: false, isAuthenticated: false };
  }

  __mergedSuite("Yjs branch handshake route guard", () => {
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
            draftId: "draft-1",
            workId: "work-1" as never,
            threadId: null,
            status: "active",
            generation: 3,
            state: storedState,
            stateVector: Y.encodeStateVectorFromUpdate(storedState),
            discardedStateVector: null,
            schemaVersion: COLLAB_SCHEMA_VERSION,
          }),
          async commitBranchMutation(input) {
            await pullBlocked;
            storedState = input.state;
            return true;
          },
          async resetBranchSnapshot() {
            return true;
          },
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
        outsideTransaction: (operation) => operation(),
        rootTransaction: (operation) => operation(),
        liveCoordinator: {
          withDocument: async (_documentId, fn) => fn(live),
          recover: async () => {},
        },
        branchCoordinator,
        branches: {
          listActiveWorkDraftBranchIds: async () => ["branch_1"],
          ensureThreadPeerBranch: async () => ({
            branchId: "thread-peer",
            upstreamBranchId: "branch_1",
            state: new Uint8Array(),
          }),
        },
      });
      const flushBranchLivePull = vi.fn(branchPulls.flushLivePull);
      const hocuspocus = createHocuspocus(
        {
          fileAccess: createAllowAllFileAccess(),
          fileAccessChanges: createLocalFileAccessChanges(),
          documentSync: {
            bindHocuspocus: vi.fn(),
            resolveBranchHocuspocusRoom: vi.fn(async () => ({
              branchId: "branch_1",
              documentId: "document-1",
              workId: "work-1",
              generation: 3,
              schemaVersion: COLLAB_SCHEMA_VERSION,
              status: "active",
            })),
            headSchemaVersion: vi.fn(async () => null),
            flushBranchLivePull,
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
    it("rejects hostile branch payloads before returning them to Hocuspocus", async () => {
      const admitBranchWriterUpdate = vi.fn(async () => {
        throw new Error("reserved provenance");
      });
      const closeTransport = vi.fn();
      const document = new Y.Doc();
      await expect(
        admitWriterSync({
          services: {
            ...services(false),
            documentSync: { admitBranchWriterUpdate } as never,
          },
          documentName,
          document,
          syncType: messageYjsUpdate,
          payload,
          userId: "user-1" as never,
          closeTransport,
          context: {
            branchSyncState: new Map([["branch_1:3", "passed"]]),
          },
        }),
      ).rejects.toMatchObject({ reason: "branch-update-admission-failed", code: 1008 });
      expect(admitBranchWriterUpdate).toHaveBeenCalledWith({
        branchId: "branch_1",
        expectedGeneration: 3,
        update: new Uint8Array([1, 2, 3]),
        origin: { type: "user", userId: "user-1" },
        document,
      });
      expect(closeTransport).toHaveBeenCalledWith({
        code: 1008,
        reason: "branch-update-admission-failed",
      });
    });
    it("waits for branch durability before returning the update to Hocuspocus", async () => {
      let commit: (() => void) | undefined;
      const admitBranchWriterUpdate = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            commit = resolve;
          }),
      );
      const admission = admitWriterSync({
        services: {
          ...services(false),
          documentSync: { admitBranchWriterUpdate } as never,
        },
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
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
    it("clears branch sync state through the route close handler", async () => {
      const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
      const handleClose = vi.fn();
      const gateway = createYjsGateway(gatewayServices());
      const connection = {
        hocuspocus: { handleClose },
        branchSyncState: state,
        offlineSyncUpdates: new Set<string>(),
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
          findById: async () => ({
            kind: "found" as const,
            document: {} as never,
            clashesWith: [],
          }),
        },
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

  __mergedSuite("Yjs live writer admission", () => {
    it("accepts a non-empty system update only after journal, then applies, broadcasts, and acks", async () => {
      const client = new Y.Doc({ gc: false });
      client.getText("content").insert(0, "non-empty system update");
      const payload = Y.encodeStateAsUpdate(client);
      const server = new Y.Doc({ gc: false });
      const events: string[] = [];
      let commit: (() => void) | undefined;
      const admitLiveWriterUpdate = vi.fn(
        () =>
          new Promise<{
            admitted: true;
            joinedSettlement: boolean;
          }>((resolve) => {
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
          expectedGeneration: 1n,
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
        expectedGeneration: 1n,
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

  __mergedSuite("Yjs room access", () => {
    const liveRoom = "00000000-0000-4000-8000-000000000201";
    function roomServices(input: { readOnly?: boolean } = {}) {
      const allowAll = createAllowAllFileAccess();
      const documentSync = {
        bindHocuspocus: vi.fn(),
        headSchemaVersion: vi.fn(async () => null),
        currentLiveGeneration: vi.fn(async () => 1n),
        admitLiveWriterUpdate: vi.fn(async () => ({
          admitted: true,
          joinedSettlement: false,
        })),
        resolveBranchHocuspocusRoom: vi.fn(async () => ({
          branchId: "branch_1",
          documentId: liveRoom,
          workId: "work-1",
          generation: 3,
          schemaVersion: COLLAB_SCHEMA_VERSION,
          status: "active",
        })),
        flushBranchLivePull: vi.fn(async () => undefined),
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
          findById: async () => ({
            kind: "found" as const,
            document: {} as never,
            clashesWith: [],
          }),
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
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4409,
        reason: "access-changed",
      });
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
});

__mergedSuite("yjs-version-gate.test.ts", () => {
  // Merged from apps/server/server/lib/routes/yjs-version-gate.test.ts.
  const branchRoomName = "branch:branch_1:gen:3";

  const liveDocumentName = "00000000-0000-4000-8000-000000000101";

  const userId = "00000000-0000-4000-8000-000000000102";

  const version = (major: number, minor: number, patch = 0): CollabSchemaVersion => ({
    major,
    minor,
    patch,
  });

  const SENTINEL_SCHEMA_VERSION = version(0, 0, 0);

  /** A head stamped by another collab schema major than this server's. */
  const OTHER_MAJOR_HEAD = version(COLLAB_SCHEMA_VERSION.major + 1, 0);

  function versionGateServices(
    input: {
      liveHead?: CollabSchemaVersion | null;
      branchHead?: CollabSchemaVersion;
      liveGeneration?: bigint;
    } = {},
  ) {
    const documentSync = {
      bindHocuspocus: vi.fn(),
      headSchemaVersion: vi.fn(async () => (input.liveHead === undefined ? null : input.liveHead)),
      resolveBranchHocuspocusRoom: vi.fn(async (branchId: string, generation: number) => ({
        branchId,
        documentId: liveDocumentName,
        workId: "00000000-0000-4000-8000-000000000107",
        generation,
        schemaVersion: input.branchHead ?? COLLAB_SCHEMA_VERSION,
        status: "active" as const,
      })),
      validateHocuspocusDocument: vi.fn(async () => {}),
      currentLiveGeneration: vi.fn(async () => input.liveGeneration ?? 1n),
      admitLiveWriterUpdate: vi.fn(async () => ({
        admitted: true as const,
        joinedSettlement: false,
      })),
      flushBranchLivePull: vi.fn(async () => undefined),
    };
    return {
      liveDocuments: {
        findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
      },
      fileAccess: createAllowAllFileAccess(),
      fileAccessChanges: createLocalFileAccessChanges(),
      documentSync,
      eventSink: createInMemoryEventSink(),
    };
  }

  function connectContext(clientSchemaVersion: CollabSchemaVersion) {
    return {
      userId,
      clientSchemaVersion,
      closeTransport: vi.fn(),
    };
  }

  function staleSchemaError() {
    return new DocumentSchemaMajorMismatchError(
      liveDocumentName,
      OTHER_MAJOR_HEAD,
      COLLAB_SCHEMA_VERSION,
    );
  }

  function connectionConfig() {
    return { readOnly: false, isAuthenticated: false };
  }

  __mergedSuite("Yjs connect-time schema version gate", () => {
    it("extracts the client version from a sole matching subprotocol offer", () => {
      expect(
        clientSchemaVersionFromRequest(
          new Request("https://meridian.local/ws/yjs", {
            headers: {
              "sec-websocket-protocol": `unrelated, ${formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)}`,
            },
          }),
        ),
      ).toEqual(COLLAB_SCHEMA_VERSION);
    });
    it("ignores a residual schema query parameter instead of using it as a fallback", () => {
      expect(
        clientSchemaVersionFromRequest(
          new Request(
            `https://meridian.local/ws/yjs?schema=${COLLAB_SCHEMA_VERSION.major}.${COLLAB_SCHEMA_VERSION.minor}.${COLLAB_SCHEMA_VERSION.patch}`,
          ),
        ),
      ).toEqual(SENTINEL_SCHEMA_VERSION);
    });
    it("refuses only live-room clients strictly older than a stored head", async () => {
      const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const staleClientContext = connectContext(SENTINEL_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: liveDocumentName,
          context: staleClientContext,
        } as never),
      ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
      expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
        code: 4406,
        reason: "client-schema-superseded",
      });
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: liveDocumentName,
          context: connectContext(COLLAB_SCHEMA_VERSION),
        } as never),
      ).resolves.toBeUndefined();
      expect(services.documentSync.headSchemaVersion).toHaveBeenCalledTimes(2);
      expect(services.documentSync.headSchemaVersion).toHaveBeenCalledWith(liveDocumentName);
    });
    it("preserves the typed refusal when event delivery fails", async () => {
      const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
      vi.spyOn(services.eventSink, "emit").mockImplementation(() => {
        throw new Error("sink-failed");
      });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const context = connectContext(SENTINEL_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: liveDocumentName,
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
      expect(context.closeTransport).toHaveBeenCalledOnce();
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4406,
        reason: "client-schema-superseded",
      });
      expect(services.eventSink.emit).toHaveBeenCalledOnce();
    });
    it("passes a live room with no stamped head, including an absent-version client", async () => {
      const services = versionGateServices({ liveHead: null });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: liveDocumentName,
          context: connectContext(SENTINEL_SCHEMA_VERSION),
        } as never),
      ).resolves.toBeUndefined();
      expect(services.eventSink.events).toEqual([]);
    });
    it("carries the admitted live generation through the sync hook", async () => {
      const services = versionGateServices({
        liveHead: COLLAB_SCHEMA_VERSION,
        liveGeneration: 9n,
      });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      const document = new Y.Doc({ gc: false });
      const payload = new Uint8Array([1, 2, 3]);
      await hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context,
      } as never);
      await hocuspocus.configuration.beforeSync?.({
        documentName: liveDocumentName,
        document,
        type: messageYjsUpdate,
        payload,
        context,
      } as never);
      expect(services.documentSync.admitLiveWriterUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          documentId: liveDocumentName,
          expectedGeneration: 9n,
        }),
      );
    });
    it("rejects sync when the admitted target does not match the message room", async () => {
      const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await hocuspocus.configuration.onConnect?.({
        connectionConfig: connectionConfig(),
        documentName: liveDocumentName,
        context,
      } as never);
      await expect(
        hocuspocus.configuration.beforeSync?.({
          documentName: "00000000-0000-4000-8000-000000000999",
          document: new Y.Doc({ gc: false }),
          type: messageYjsUpdate,
          payload: new Uint8Array([1, 2, 3]),
          context,
        } as never),
      ).rejects.toMatchObject({ reason: "permission-denied" });
      expect(services.documentSync.admitLiveWriterUpdate).not.toHaveBeenCalled();
    });
    it("gates branch rooms at the same strict monotonic edge", async () => {
      const hocuspocus = createHocuspocus(
        versionGateServices({ branchHead: COLLAB_SCHEMA_VERSION }) as never,
        createYjsRoomAccessIndex(),
      );
      const staleClientContext = connectContext(SENTINEL_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: branchRoomName,
          context: staleClientContext,
        } as never),
      ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
      expect(staleClientContext.closeTransport).toHaveBeenCalledWith({
        code: 4406,
        reason: "client-schema-superseded",
      });
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: branchRoomName,
          context: connectContext(COLLAB_SCHEMA_VERSION),
        } as never),
      ).resolves.toBeUndefined();
    });
    it("refuses major-mismatched live and branch heads per connection", async () => {
      const majorMismatchHead = OTHER_MAJOR_HEAD;
      const services = versionGateServices({
        liveHead: majorMismatchHead,
        branchHead: majorMismatchHead,
      });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      for (const room of [liveDocumentName, branchRoomName]) {
        const context = connectContext(COLLAB_SCHEMA_VERSION);
        await expect(
          hocuspocus.configuration.onConnect?.({
            documentName: room,
            context,
            connectionConfig: connectionConfig(),
          } as never),
        ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
        expect(context.closeTransport).toHaveBeenCalledWith({
          code: 4407,
          reason: "document-schema-stale",
        });
      }
    });
    it("prioritizes a server-stale head over an even older client", async () => {
      const hocuspocus = createHocuspocus(
        versionGateServices({ liveHead: OTHER_MAJOR_HEAD }) as never,
        createYjsRoomAccessIndex(),
      );
      const context = connectContext(SENTINEL_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onConnect?.({
          connectionConfig: connectionConfig(),
          documentName: liveDocumentName,
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    });
    it.each([
      ["live", liveDocumentName],
      ["branch", branchRoomName],
    ])("keeps the typed stale-head close on the %s document-load guard", async (_kind, room) => {
      const services = versionGateServices({ liveHead: null });
      Object.assign(services.documentSync, {
        loadHocuspocusDocument: vi.fn(async () => {
          throw staleSchemaError();
        }),
        loadHocuspocusBranchState: vi.fn(async () => {
          throw staleSchemaError();
        }),
      });
      const hocuspocus = createHocuspocus(services as never, createYjsRoomAccessIndex());
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        hocuspocus.configuration.onLoadDocument?.({
          documentName: room,
          document: new Y.Doc({ gc: false }),
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith({
        code: 4407,
        reason: "document-schema-stale",
      });
    });
  });
});
