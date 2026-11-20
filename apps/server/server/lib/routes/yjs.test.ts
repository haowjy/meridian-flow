/**
 * Tests yjs behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Current Yjs handshake protocol
 */
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import { messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import {
  createAllowAllFileAccess,
  createLocalFileAccessChanges,
  type FileAccessDenied,
  type FileGrant,
  isFileAccessDenied,
} from "../../domains/file-policy/index.js";
import { createYjsRoomAccessIndex } from "../yjs-room-access.js";
import { admitWriterSync, createHocuspocus, createYjsGateway } from "../yjs-ws-handler.js";

const documentName = "draft:draft_1";

const payload = new Uint8Array([1, 2, 3]);

function services() {
  return {
    fileAccess: {} as never,
    fileAccessChanges: createLocalFileAccessChanges(),
    liveDocuments: {
      findById: async () => ({ kind: "found" as const, document: {} as never, clashesWith: [] }),
    },
    eventSink: {} as never,
    treeLists: { onCommitted: () => () => {}, onJournalAdvanced: () => () => {} } as never,
    documentSync: {
      roomRemoval: vi.fn(async () => null),
      ensureDocumentAuthority: vi.fn(async () => {}),
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
    treeLists: { onCommitted: () => () => {}, onJournalAdvanced: () => () => {} } as never,
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
  it("closes with 1013 when draft admission throws", async () => {
    const admitDraftWriterUpdate = vi.fn(async () => {
      throw new Error("reserved provenance");
    });
    const document = new Y.Doc();

    await expect(
      admitWriterSync({
        services: {
          ...services(),
          documentSync: { admitDraftWriterUpdate, roomRemoval: async () => null } as never,
        },
        documentName,
        document,
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
      }),
    ).rejects.toMatchObject({ reason: "writer-journal-admission-failed", code: 1013 });
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
        ...services(),
        documentSync: { admitDraftWriterUpdate, roomRemoval: async () => null } as never,
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
      eventSink: { emit: vi.fn() } as never,
      treeLists: { onCommitted: () => () => {}, onJournalAdvanced: () => () => {} } as never,
      documentSync: {
        roomRemoval: vi.fn(async () => null),
        ensureDocumentAuthority: vi.fn(async () => {}),
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

  it("rejects a failed admission with a retryable close", async () => {
    const payload = new Uint8Array([7, 8, 9]);
    const admitLiveWriterUpdate = vi.fn().mockRejectedValue(new Error("journal down"));
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
      expectedGeneration: 1n,
    };

    await expect(admitWriterSync(input)).rejects.toMatchObject({
      reason: "writer-journal-admission-failed",
      code: 1013,
    });
  });
});

describe("Yjs room access", () => {
  const liveRoom = "00000000-0000-4000-8000-000000000201";

  function roomServices(input: { readOnly?: boolean } = {}) {
    const allowAll = createAllowAllFileAccess();
    const documentSync = {
      roomRemoval: vi.fn(async () => null),
      ensureDocumentAuthority: vi.fn(async () => {}),
      bindHocuspocus: vi.fn(),
      headSchemaVersion: vi.fn(async () => null),
      currentLiveGeneration: vi.fn(async () => 1n),
      admitLiveWriterUpdate: vi.fn(async () => ({ admitted: true })),
      resolveDraftHocuspocusRoom: vi.fn(async () => ({
        draftId: "draft_1",
        documentId: liveRoom,
        owner: { kind: "work" as const, workId: "work-1" },
        schemaVersion: COLLAB_SCHEMA_VERSION,
        status: "active",
      })),
      catchUpDraft: vi.fn(async () => undefined),
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
      eventSink: { emit() {} } as never,
      treeLists: { onCommitted: () => () => {}, onJournalAdvanced: () => () => {} } as never,
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
