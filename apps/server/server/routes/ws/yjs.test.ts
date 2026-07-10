import { MessageType } from "@hocuspocus/server";
import {
  createEncoder,
  toUint8Array,
  writeVarString,
  writeVarUint,
  writeVarUint8Array,
} from "lib0/encoding";
import { describe, expect, it, vi } from "vitest";
import { messageYjsSyncStep1, messageYjsUpdate } from "y-protocols/sync";
import type { WriterNoticeListener } from "../../domains/notices/index.js";
import {
  type BranchHandshakeState,
  createYjsWebSocketHooks,
  enforceBranchHandshake,
  subscribeWriterNoticeTransport,
} from "./yjs";

const documentName = "branch:branch_1:gen:3";

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

describe("Yjs branch handshake route guard", () => {
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
