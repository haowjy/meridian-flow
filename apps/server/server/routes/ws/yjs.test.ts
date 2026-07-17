import { MessageType } from "@hocuspocus/server";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { StaleDocumentSchemaError } from "../../domains/collab/index.js";
import type { WriterNoticeListener } from "../../domains/notices/index.js";
import {
  admitBranchWriterMessage,
  admitLiveWriterMessage,
  type BranchHandshakeState,
  clientSchemaVersionFromRequest,
  createYjsHocuspocus,
  createYjsWebSocketHooks,
  enforceBranchHandshake,
  subscribeWriterNoticeTransport,
} from "./yjs";

const documentName = "branch:branch_1:gen:3";
const liveDocumentName = "00000000-0000-4000-8000-000000000101";
const userId = "00000000-0000-4000-8000-000000000102";

function syncMessage(syncType: number): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Sync);
  writeVarUint(encoder, syncType);
  writeVarUint8Array(encoder, new Uint8Array([1, 2, 3]));
  return toUint8Array(encoder);
}

function awarenessMessage(): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, documentName);
  writeVarUint(encoder, MessageType.Awareness);
  return toUint8Array(encoder);
}

function services(stale: boolean) {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    notices: {} as never,
    documentSync: {
      rejectStaleBranchSyncStep1: vi.fn(async () => stale),
    } as never,
  };
}

function versionGateServices(input: { liveHead?: number | null; branchHead?: number } = {}) {
  const documentSync = {
    bindHocuspocus: vi.fn(),
    headSchemaVersion: vi.fn(async () => input.liveHead ?? null),
    resolveBranchHocuspocusRoom: vi.fn(async (branchId: string, generation: number) => ({
      branchId,
      documentId: liveDocumentName,
      generation,
      schemaVersion: input.branchHead ?? 1,
      status: "active" as const,
    })),
    resolveManifestMembership: vi.fn(async () => ({
      documentId: liveDocumentName,
      members: [liveDocumentName],
    })),
    currentLiveGeneration: vi.fn(async () => 1n),
  };
  return {
    documentAccess: {
      canAccessDocument: vi.fn(async () => true),
      projectIdForDocument: vi.fn(async () => "00000000-0000-4000-8000-000000000103"),
    },
    documentSync,
    eventSink: { emit() {} },
    notices: {
      subscribeWriterVisible: vi.fn(() => () => {}),
      drainForWriter: vi.fn(async () => []),
    },
  };
}

function connectContext(clientSchemaVersion: number) {
  return {
    userId,
    clientSchemaVersion,
    liveGenerations: new Map<string, bigint>(),
    closeTransport: vi.fn(),
  };
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected configured Hocuspocus hook");
  return value;
}

describe("Yjs connect-time schema version gate", () => {
  it("parses the declared schema version and treats absent or invalid values as zero", () => {
    expect(
      clientSchemaVersionFromRequest(new Request("https://meridian.local/ws/yjs?schema=4")),
    ).toBe(4);
    for (const url of [
      "https://meridian.local/ws/yjs",
      "https://meridian.local/ws/yjs?schema=",
      "https://meridian.local/ws/yjs?schema=-1",
      "https://meridian.local/ws/yjs?schema=1.5",
      "https://meridian.local/ws/yjs?schema=9007199254740992",
    ]) {
      expect(clientSchemaVersionFromRequest(new Request(url))).toBe(0);
    }
  });

  it("refuses only live-room clients strictly older than a stored head", async () => {
    const services = versionGateServices({ liveHead: COLLAB_SCHEMA_VERSION });
    const hocuspocus = createYjsHocuspocus(services as never);
    const staleClientContext = connectContext(COLLAB_SCHEMA_VERSION - 1);

    await expect(
      required(hocuspocus.configuration.onConnect)({
        documentName: liveDocumentName,
        context: staleClientContext,
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    expect(staleClientContext.closeTransport).toHaveBeenCalledWith(
      4406,
      "client-schema-superseded",
    );
    await expect(
      required(hocuspocus.configuration.onConnect)({
        documentName: liveDocumentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
    expect(services.documentSync.headSchemaVersion).toHaveBeenCalledWith(liveDocumentName);
  });

  it("passes a live room with no stamped head", async () => {
    const hocuspocus = createYjsHocuspocus(versionGateServices({ liveHead: null }) as never);

    await expect(
      required(hocuspocus.configuration.onConnect)({
        documentName: liveDocumentName,
        context: connectContext(0),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("uses the branch row schema and preserves the same strict monotonic edge", async () => {
    const hocuspocus = createYjsHocuspocus(
      versionGateServices({ branchHead: COLLAB_SCHEMA_VERSION }) as never,
    );

    await expect(
      required(hocuspocus.configuration.onConnect)({
        documentName,
        context: connectContext(COLLAB_SCHEMA_VERSION - 1),
      } as never),
    ).rejects.toMatchObject({ code: 4406, reason: "client-schema-superseded" });
    await expect(
      required(hocuspocus.configuration.onConnect)({
        documentName,
        context: connectContext(COLLAB_SCHEMA_VERSION),
      } as never),
    ).resolves.toBeUndefined();
  });

  it("refuses stale live and branch heads per connection before document loading", async () => {
    const services = versionGateServices({
      liveHead: COLLAB_SCHEMA_VERSION - 1,
      branchHead: COLLAB_SCHEMA_VERSION - 1,
    });
    const hocuspocus = createYjsHocuspocus(services as never);

    for (const room of [liveDocumentName, documentName]) {
      const context = connectContext(COLLAB_SCHEMA_VERSION);
      await expect(
        required(hocuspocus.configuration.onConnect)({
          documentName: room,
          context,
        } as never),
      ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
      expect(context.closeTransport).toHaveBeenCalledWith(4407, "document-schema-stale");
    }
  });

  it("maps stale stored heads to the typed document-schema-stale close", async () => {
    const services = versionGateServices();
    Object.assign(services.documentSync, {
      loadHocuspocusDocument: vi.fn(async () => {
        throw new StaleDocumentSchemaError(liveDocumentName, 1, 2);
      }),
    });
    const hocuspocus = createYjsHocuspocus(services as never);
    const context = connectContext(2);

    await expect(
      required(hocuspocus.configuration.onLoadDocument)({
        documentName: liveDocumentName,
        document: new Y.Doc({ gc: false }),
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith(4407, "document-schema-stale");
  });

  it("maps a stale branch head to the same typed close", async () => {
    const services = versionGateServices();
    Object.assign(services.documentSync, {
      loadHocuspocusBranchState: vi.fn(async () => {
        throw new StaleDocumentSchemaError(liveDocumentName, 1, 2);
      }),
    });
    const hocuspocus = createYjsHocuspocus(services as never);
    const context = connectContext(2);

    await expect(
      required(hocuspocus.configuration.onLoadDocument)({
        documentName,
        document: new Y.Doc({ gc: false }),
        context,
      } as never),
    ).rejects.toMatchObject({ code: 4407, reason: "document-schema-stale" });
    expect(context.closeTransport).toHaveBeenCalledWith(4407, "document-schema-stale");
  });
});

describe("Yjs branch handshake route guard", () => {
  it("rejects hostile branch payloads before returning them to Hocuspocus", async () => {
    const validateBranchWriterUpdate = vi.fn(async () => {
      throw new Error("reserved provenance");
    });
    const closeTransport = vi.fn();

    await expect(
      admitBranchWriterMessage({
        services: {
          ...services(false),
          documentSync: { validateBranchWriterUpdate } as never,
        },
        documentName,
        update: syncMessage(messageYjsUpdate),
        closeTransport,
      }),
    ).rejects.toMatchObject({ reason: "branch-update-admission-failed", code: 1008 });
    expect(validateBranchWriterUpdate).toHaveBeenCalledWith({
      branchId: "branch_1",
      expectedGeneration: 3,
      update: new Uint8Array([1, 2, 3]),
    });
    expect(closeTransport).toHaveBeenCalledOnce();
  });

  it("forwards writer-visible notice events as stateless WebSocket messages", async () => {
    let listener: WriterNoticeListener | undefined;
    const drainForWriter = vi.fn(async () => []);
    const broadcastStateless = vi.fn();
    subscribeWriterNoticeTransport({
      notices: {
        async record() {},
        async drainForModelContext() {
          return [];
        },
        drainForWriter,
        subscribeWriterVisible(next) {
          listener = next;
          return () => {};
        },
      },
      documentsForId: async () => [{ getConnectionsCount: () => 1, broadcastStateless }],
      eventSink: { emit() {} } as never,
    });

    listener?.({
      documentId: "00000000-0000-4000-8000-000000000001",
      kind: "late_sweep",
      message: "Content was modified — View change",
      data: { beforeContentRef: 42 },
    });
    await Promise.resolve();

    expect(JSON.parse(broadcastStateless.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "safety_notice",
      documentId: "00000000-0000-4000-8000-000000000001",
      kind: "late_sweep",
      message: "Content was modified — View change",
    });
    expect(drainForWriter).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
  });

  it("rejects update-first sync messages", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      enforceBranchHandshake({
        services: services(false),
        documentName,
        update: syncMessage(messageYjsUpdate),
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("passes awareness messages through without a branch sync state", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      enforceBranchHandshake({
        services: services(true),
        documentName,
        update: awarenessMessage(),
        context: { branchSyncState: state },
      }),
    ).resolves.toBeUndefined();
    expect(state.size).toBe(0);
  });

  it("keeps a rejected room rejected when a later step1 would pass", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await expect(
      enforceBranchHandshake({
        services: services(false),
        documentName,
        update: syncMessage(messageYjsUpdate),
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc" });
    await expect(
      enforceBranchHandshake({
        services: services(false),
        documentName,
        update: syncMessage(messageYjsSyncStep1),
        context: { branchSyncState: state },
      }),
    ).rejects.toMatchObject({ reason: "branch-stale-doc", code: 4205 });
    expect(state.get("branch_1:3")).toBe("rejected");
  });

  it("allows a fresh client to pass step1 then send updates", async () => {
    const state = new Map<string, BranchHandshakeState>();
    await enforceBranchHandshake({
      services: services(false),
      documentName,
      update: syncMessage(messageYjsSyncStep1),
      context: { branchSyncState: state },
    });
    await expect(
      enforceBranchHandshake({
        services: services(false),
        documentName,
        update: syncMessage(messageYjsUpdate),
        context: { branchSyncState: state },
      }),
    ).resolves.toBeUndefined();
    expect(state.get("branch_1:3")).toBe("passed");
  });

  it("clears branch sync state through the route close handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const peer = {
      context: {
        kind: "authenticated" as const,
        app: {} as never,
        userId: "00000000-0000-4000-8000-000000000001" as never,
        branchSyncState: state,
      },
      _hocuspocus: { handleClose },
    };

    await createYjsWebSocketHooks().close(peer as never, { code: 1000, reason: "test" } as never);

    expect(handleClose).toHaveBeenCalledWith({ code: 1000, reason: "test" });
    expect(state.size).toBe(0);
    expect("_hocuspocus" in peer).toBe(false);
  });

  it("clears branch sync state through the route error handler", async () => {
    const state = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const handleClose = vi.fn();
    const peer = {
      context: {
        kind: "authenticated" as const,
        app: {} as never,
        userId: "00000000-0000-4000-8000-000000000001" as never,
        branchSyncState: state,
      },
      _hocuspocus: { handleClose },
    };

    await createYjsWebSocketHooks().error(peer as never);

    expect(handleClose).toHaveBeenCalledWith({ code: 1011, reason: "error" });
    expect(state.size).toBe(0);
    expect("_hocuspocus" in peer).toBe(false);
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
        new Promise<{ joinedSettlement: boolean }>((resolve) => {
          events.push("accept");
          commit = () => {
            events.push("journal");
            resolve({ joinedSettlement: true });
          };
        }),
    );
    const admission = admitLiveWriterMessage({
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      update: addressedSyncMessage("document-1", messageYjsUpdate, payload),
      userId: "user-1" as never,
    });

    await Promise.resolve();
    expect(admitLiveWriterUpdate).toHaveBeenCalledWith({
      documentId: "document-1",
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
      admitLiveWriterMessage({
        services: {
          ...services(false),
          documentSync: { admitLiveWriterUpdate } as never,
        },
        documentName: "document-1",
        update: addressedSyncMessage("document-1", messageYjsUpdate, new Uint8Array()),
        userId: "user-1" as never,
      }),
    ).resolves.toBeUndefined();
    expect(admitLiveWriterUpdate).not.toHaveBeenCalled();
  });

  it("rejects a failed admission and accepts the client's resubmitted update", async () => {
    const payload = new Uint8Array([7, 8, 9]);
    const admitLiveWriterUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("journal down"))
      .mockResolvedValueOnce({ joinedSettlement: false });
    const closeTransport = vi.fn();
    const input = {
      services: {
        ...services(false),
        documentSync: { admitLiveWriterUpdate } as never,
      },
      documentName: "document-1",
      update: addressedSyncMessage("document-1", messageYjsUpdate, payload),
      userId: "user-1" as never,
      closeTransport,
    };

    await expect(admitLiveWriterMessage(input)).rejects.toMatchObject({
      reason: "writer-journal-admission-failed",
      code: 1013,
    });
    expect(closeTransport).toHaveBeenCalledOnce();
    await expect(admitLiveWriterMessage(input)).resolves.toBeUndefined();
    expect(admitLiveWriterUpdate).toHaveBeenCalledTimes(2);
  });
});

function addressedSyncMessage(room: string, syncType: number, payload: Uint8Array): Uint8Array {
  const encoder = createEncoder();
  writeVarString(encoder, room);
  writeVarUint(encoder, MessageType.Sync);
  writeVarUint(encoder, syncType);
  writeVarUint8Array(encoder, payload);
  return toUint8Array(encoder);
}
