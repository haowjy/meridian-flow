/** Real branch sessions and owners, with a wire whose sync and acknowledgements the test controls. */
import { vi } from "vitest";
import * as Y from "yjs";
import { BranchRoomPool, type BranchRoomRef } from "@/core/editor/branch-room-pool";
import { BranchWriterHandoff } from "@/core/editor/branch-writer-handoff";
import {
  DocumentSession,
  type DocumentSessionConnectionState,
  type DocumentSessionTransportProvider,
} from "@/core/editor/document-session";
import { DocumentSessionTeardownOwner } from "@/core/editor/document-session-teardown-owner";

export class HeldBranchTransport implements DocumentSessionTransportProvider {
  synced = false;
  private finishSync!: () => void;
  readonly whenSynced = new Promise<void>((resolve) => {
    this.finishSync = resolve;
  });
  private state: DocumentSessionConnectionState = { kind: "connecting", attempt: 1 };
  private scope: "edit" | "read" = "edit";
  private pending: Uint8Array | null = null;
  private terminal = false;
  private status = new Set<(state: DocumentSessionConnectionState) => void>();
  private acknowledgements = new Set<(ack: boolean) => void>();
  private access = new Set<(access: "edit" | "read") => void>();
  readonly sent: Uint8Array[] = [];
  constructor(readonly document: Y.Doc) {
    document.on("update", this.updated);
  }
  private updated = (update: Uint8Array, origin: unknown) => {
    if (this.terminal || origin === this) return;
    this.pending = this.pending ? Y.mergeUpdates([this.pending, update]) : update;
    this.sent.push(update);
    for (const listener of this.acknowledgements) listener(false);
  };
  unacknowledgedUpdates = () => this.pending;
  subscribeStatus = (listener: (state: DocumentSessionConnectionState) => void) => {
    this.status.add(listener);
    listener(this.state);
    return () => this.status.delete(listener);
  };
  subscribeAccess = (listener: (access: "edit" | "read") => void) => {
    this.access.add(listener);
    listener(this.scope);
    return () => this.access.delete(listener);
  };
  subscribeServerAcknowledgement = (listener: (ack: boolean) => void) => {
    this.acknowledgements.add(listener);
    listener(!this.pending && this.synced);
    return () => this.acknowledgements.delete(listener);
  };
  sync(baseline?: Uint8Array, scope: "edit" | "read" = "edit") {
    if (baseline) Y.applyUpdate(this.document, baseline, this);
    this.scope = scope;
    for (const listener of this.access) listener(scope);
    this.synced = true;
    this.finishSync();
    this.emit({ kind: "connected" });
  }
  ack() {
    this.pending = null;
    for (const listener of this.acknowledgements) listener(true);
  }
  emit(state: DocumentSessionConnectionState) {
    this.state = state;
    if (state.kind === "reset" || state.kind === "unauthorized") this.terminal = true;
    for (const listener of this.status) listener(state);
  }
  destroy = () => {
    this.terminal = true;
    this.document.off("update", this.updated);
  };
}

export function branchHandoffHarness() {
  const wires = new Map<string, HeldBranchTransport[]>();
  const epoch = new AbortController();
  const teardown = new DocumentSessionTeardownOwner(() => new Error("quarantined"));
  let handoff: BranchWriterHandoff;
  const pool = new BranchRoomPool({
    teardownGraceMs: 10,
    teardownOwner: teardown,
    carry: (carry) => handoff.carry(carry),
    openSession: (roomKey) =>
      new DocumentSession({
        roomKey,
        persistence: { kind: "none" },
        transportFactory: ({ document }) => {
          const wire = new HeldBranchTransport(document);
          wires.set(roomKey, [...(wires.get(roomKey) ?? []), wire]);
          return wire;
        },
      }),
  });
  handoff = new BranchWriterHandoff({ pool, epochSignal: epoch.signal, retryDelaysMs: [10] });
  const wire = (room: string) => {
    const transport = wires.get(room)?.at(-1);
    if (!transport) throw new Error(`No transport for ${room}`);
    return transport;
  };
  const changed = vi.fn();
  let currentRoom: () => Promise<string | null> = async () => null;
  const ref = (roomKey: string): BranchRoomRef => ({
    roomKey,
    currentRoom: () => currentRoom(),
    changed,
  });
  return {
    pool,
    wire,
    wires,
    epoch,
    changed,
    ref,
    handoff,
    locate: (locate: () => Promise<string | null>) => {
      currentRoom = locate;
    },
    async dispose() {
      handoff.dispose();
      pool.invalidate();
      await teardown.drain();
    },
  };
}
