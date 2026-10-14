import { readBlocks, UNKNOWN_BASE_REVISION, writeBlocks } from "@meridian/agent-edit/diff";
import type { DraftBaseRevision } from "@meridian/contracts";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import {
  COLLAB_SCHEMA_VERSION,
  formatCollabSchemaSubprotocol,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  BranchWriterRefusedError,
  createBranchCoordinator,
} from "../../domains/collab/domain/branch-coordinator.js";
import { createBranchPullService } from "../../domains/collab/domain/branch-pulls.js";
import {
  createDraftRebase,
  draftSchema,
  seedDraftState,
} from "../../domains/collab/domain/draft-rebase.js";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
} from "../../domains/file-policy/index.js";
import { createYjsRoomAccessIndex } from "../yjs-room-access.js";
import { admitWriterSync, createHocuspocus, createYjsGateway } from "../yjs-ws-handler.js";

const documentName = "branch:branch_1";

function paragraph(text: string) {
  return draftSchema.nodes.paragraph.create(null, draftSchema.text(text));
}

function textOf(doc: Y.Doc): string {
  return readBlocks(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema)
    .map((block) => block.textContent)
    .join("\n");
}

function typeAtStart(doc: Y.Doc, text: string): void {
  const first = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).get(0) as Y.XmlElement;
  (first.get(0) as Y.XmlText).insert(0, text);
}

const payload = new Uint8Array([1, 2, 3]);

function services() {
  return {
    fileAccess: {} as never,
    fileAccessChanges: createLocalFileAccessChanges(),
    liveDocuments: {
      findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
    },
    eventSink: {} as never,
    documentSync: {
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

describe("Yjs branch handshake route guard", () => {
  it("holds a branch connection until the live pull and the room share one state", async () => {
    const live = new Y.Doc({ gc: false });
    writeBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema, [
      paragraph("live advanced"),
    ]);
    let stored = seedDraftState(new Y.Doc({ gc: false })).state;
    let baseRevision: DraftBaseRevision | null = UNKNOWN_BASE_REVISION;
    const loadedRoom = new Y.Doc({ gc: false });
    Y.applyUpdate(loadedRoom, stored);
    let releasePull: (() => void) | undefined;
    const pullBlocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const write = (input: { state: Uint8Array; baseRevision?: DraftBaseRevision }) => {
      stored = input.state;
      if (input.baseRevision) baseRevision = input.baseRevision;
    };
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
          generation: 1,
          state: stored,
          stateVector: Y.encodeStateVectorFromUpdate(stored),
          discardedStateVector: null,
          baseRevision,
          schemaVersion: COLLAB_SCHEMA_VERSION,
        }),
        async commitBranchMutation(input) {
          write(input);
          return true;
        },
        async resetBranchSnapshot() {
          return true;
        },
        async updateBranchSnapshot(input) {
          await pullBlocked;
          write(input);
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
      liveCoordinator: { withDocument: async (_id, fn) => fn(live), recover: async () => {} },
      branchCoordinator,
      draftRebase: createDraftRebase({
        branchCoordinator,
        liveCut: {
          read: async () => ({
            revision: { authorityId: "live", authorityGeneration: "1", seq: 1 },
            blocks: readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), draftSchema),
          }),
        },
        blockingApplySettlement: async () => null,
      }),
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

    let connected = false;
    const connecting = hocuspocus.configuration.onConnect?.({
      connectionConfig: connectionConfig(),
      documentName,
      context: { userId: "user-1", clientSchemaVersion: COLLAB_SCHEMA_VERSION },
    } as never);
    void connecting?.then(() => {
      connected = true;
    });
    await vi.waitFor(() => expect(flushBranchLivePull).toHaveBeenCalledWith("document-1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(connected).toBe(false);

    releasePull?.();
    await connecting;
    expect(textOf(loadedRoom)).toBe("live advanced");
    const persisted = new Y.Doc({ gc: false });
    Y.applyUpdate(persisted, stored);
    expect(textOf(persisted)).toBe("live advanced");

    // The reconnect handshake is admitted: the room and the durable branch agree.
    const offline = new Y.Doc({ gc: false });
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(loadedRoom));
    const before = Y.encodeStateVector(offline);
    typeAtStart(offline, "offline ");
    await expect(
      branchCoordinator.commitWriterUpdate({
        branchId: "branch_1",
        updateData: Y.encodeStateAsUpdate(offline, before),
        roomDocument: loadedRoom,
      }),
    ).resolves.toEqual({ admitted: true });

    // A pull committed mid-session: this room is behind the durable snapshot. The frame is early, not
    // hostile, so the room is caught up under the lock and the frame is admitted.
    const staleRoom = new Y.Doc({ gc: false });
    const lateFrame = new Y.Doc({ gc: false });
    Y.applyUpdate(lateFrame, stored);
    const lateBefore = Y.encodeStateVector(lateFrame);
    typeAtStart(lateFrame, "late ");
    await expect(
      branchCoordinator.commitWriterUpdate({
        branchId: "branch_1",
        updateData: Y.encodeStateAsUpdate(lateFrame, lateBefore),
        roomDocument: staleRoom,
      }),
    ).resolves.toEqual({ admitted: true });
    // The room was caught up to the durable snapshot before the frame; the frame is durable too.
    expect(textOf(staleRoom)).toBe("offline live advanced");
    const durable = new Y.Doc({ gc: false });
    Y.applyUpdate(durable, stored);
    expect(textOf(durable)).toBe("late offline live advanced");
  });

  it.each([
    { name: "a refusal ends the room as terminal", closed: false, close: WS_CLOSE.WRITE_REFUSED },
    { name: "a closed draft ends the room as closed", closed: true, close: WS_CLOSE.BRANCH_CLOSED },
  ])("$name, never a reconnectable 1008", async ({ closed, close }) => {
    const admitBranchWriterUpdate = vi.fn(async () => {
      throw new BranchWriterRefusedError("branch_1", closed, new Error("reserved provenance"));
    });
    const closeTransport = vi.fn();
    const document = new Y.Doc();

    await expect(
      admitWriterSync({
        services: { ...services(), documentSync: { admitBranchWriterUpdate } as never },
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
      }),
    ).rejects.toMatchObject({ reason: close.reason, code: close.code });
    expect(admitBranchWriterUpdate).toHaveBeenCalledWith({
      branchId: "branch_1",
      update: new Uint8Array([1, 2, 3]),
      origin: { type: "user", userId: "user-1" },
      document,
    });
    expect(closeTransport).toHaveBeenCalledWith(close);
  });

  it("closes a failure that is not a verdict as reconnectable", async () => {
    const closeTransport = vi.fn();
    await expect(
      admitWriterSync({
        services: {
          ...services(),
          documentSync: {
            admitBranchWriterUpdate: vi.fn(async () => {
              throw new Error("database down");
            }),
          } as never,
        },
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
      }),
    ).rejects.toMatchObject({ code: 1013 });
    expect(closeTransport).toHaveBeenCalledWith({
      code: 1013,
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
        ...services(),
        documentSync: { admitBranchWriterUpdate } as never,
      },
      documentName,
      document: new Y.Doc(),
      syncType: messageYjsUpdate,
      payload,
      userId: "user-1" as never,
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
        ...services(),
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
          ...services(),
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
          ...services(),
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
        ...services(),
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

describe("Yjs room access", () => {
  const liveRoom = "00000000-0000-4000-8000-000000000201";

  function roomServices(input: { readOnly?: boolean } = {}) {
    const allowAll = createAllowAllFileAccess();
    const documentSync = {
      bindHocuspocus: vi.fn(),
      headSchemaVersion: vi.fn(async () => null),
      currentLiveGeneration: vi.fn(async () => 1n),
      admitLiveWriterUpdate: vi.fn(async () => ({ admitted: true, joinedSettlement: false })),
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
