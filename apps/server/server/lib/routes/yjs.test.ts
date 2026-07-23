import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import type { WriterNoticeListener } from "../../domains/notices/index.js";
import {
  admitWriterSync,
  type BranchHandshakeState,
  createYjsWebSocketHooks,
  subscribeWriterNoticeTransport,
} from "../../routes/ws/yjs.js";

const documentName = "branch:branch_1:gen:3";

const payload = new Uint8Array([1, 2, 3]);

function services(stale: boolean) {
  return {
    documentAccess: {} as never,
    eventSink: {} as never,
    notices: {} as never,
    documentSync: {
      rejectStaleBranchSyncStep1: vi.fn(async () => stale),
      validateBranchWriterUpdate: vi.fn(async () => undefined),
    } as never,
  };
}

describe("Yjs branch handshake route guard", () => {
  it("rejects hostile branch payloads before returning them to Hocuspocus", async () => {
    const validateBranchWriterUpdate = vi.fn(async () => {
      throw new Error("reserved provenance");
    });
    const closeTransport = vi.fn();

    await expect(
      admitWriterSync({
        services: {
          ...services(false),
          documentSync: { validateBranchWriterUpdate } as never,
        },
        documentName,
        document: new Y.Doc(),
        syncType: messageYjsUpdate,
        payload,
        userId: "user-1" as never,
        closeTransport,
        context: {
          branchSyncState: new Map([["branch_1:3", "passed"]]),
        },
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

  it("allows a fresh client to pass step1 then send updates", async () => {
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
        payload,
        userId: "user-1" as never,
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
    expect(closeTransport).toHaveBeenCalledOnce();
    await expect(admitWriterSync(input)).resolves.toEqual({
      admitted: true,
      joinedSettlement: false,
    });
    expect(admitLiveWriterUpdate).toHaveBeenCalledTimes(2);
  });
});
