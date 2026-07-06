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
import { type BranchHandshakeState, enforceBranchHandshake } from "./yjs";

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
    documentSync: {
      rejectStaleBranchSyncStep1: vi.fn(async () => stale),
    } as never,
  };
}

describe("Yjs branch handshake route guard", () => {
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

  it("disconnect clears state by using a fresh room map", async () => {
    const rejected = new Map<string, BranchHandshakeState>([["branch_1:3", "rejected"]]);
    const fresh = new Map<string, BranchHandshakeState>();
    expect(rejected.get("branch_1:3")).toBe("rejected");
    await expect(
      enforceBranchHandshake({
        services: services(false),
        documentName,
        update: syncMessage(messageYjsSyncStep1),
        context: { branchSyncState: fresh },
      }),
    ).resolves.toBeUndefined();
    expect(fresh.get("branch_1:3")).toBe("passed");
  });
});
