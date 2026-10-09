/**
 * The session registry's generation-fenced branch (review) rooms: retained per
 * owner, torn down after a grace period once no owner holds them, retired when
 * they reset, and rebuilt on request. Branch rooms hold no lease. Retaining and
 * releasing only record ownership; a room opens on `get` or `rebuild`.
 */
import { parseYjsRoomName } from "@meridian/contracts/protocol";

import type { DocumentSession } from "./document-session";
import type { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

export type BranchRoomRef = Readonly<{
  roomKey: string;
  currentRoom(): Promise<string | null>;
  changed(): void;
}>;
export type BranchRoomRetirement = Readonly<
  | {
      kind: "carried";
      ref: BranchRoomRef;
      disposition: "superseded" | "rebuild";
      source: { roomKey: string; generation: number };
      carry: Uint8Array;
    }
  | {
      kind: "retired";
      roomKey: string;
      cause: "released" | "superseded" | "rebuild" | "refused" | "schema" | "closed";
    }
>;

export class BranchRoomPool {
  private readonly refs = new Map<string, BranchRoomRef>();
  private readonly draining = new Set<string>();
  private readonly rooms = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Map<string, BranchRoomRef>>();
  private readonly teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      /** A new session for the room, published to its observers with its transport attached. */
      openSession(roomKey: string): DocumentSession;
      teardownOwner: DocumentSessionTeardownOwner;
      teardownGraceMs: number;
      retired?(retirement: BranchRoomRetirement): void;
    },
  ) {}

  peek(roomKey: string): DocumentSession | undefined {
    return this.rooms.get(roomKey);
  }

  retain(ownerId: string, refs: readonly BranchRoomRef[]): void {
    const keys = new Set(refs.map((ref) => ref.roomKey));
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "branch") {
        throw new Error(`Branch retention requires a branch room: ${roomKey}`);
      }
    }
    for (const ref of refs) this.refs.set(ref.roomKey, ref);
    this.retainedByOwner.set(ownerId, new Map(refs.map((ref) => [ref.roomKey, ref])));
    for (const roomKey of keys) this.cancelTeardown(roomKey);
    this.reconcile();
  }

  release(ownerId: string): void {
    this.retainedByOwner.delete(ownerId);
    this.reconcile();
  }

  async rebuild(roomKey: string): Promise<DocumentSession> {
    // A reset branch session is already retired; wait out its teardown quarantine.
    await this.deps.teardownOwner.drainRoom({ kind: "branch", roomKey });
    // The last owner can leave while the drain waits. Reopening then would start a session
    // nothing owns and nothing would ever tear down.
    if (!this.isRetained(roomKey)) throw new Error(`Branch room was released: ${roomKey}`);
    return this.get(roomKey);
  }

  get(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "branch")
      throw new Error(`Branch session requires a branch room: ${roomKey}`);
    this.cancelTeardown(roomKey);
    this.deps.teardownOwner.assertAvailable({ kind: "branch", roomKey });
    const existing = this.rooms.get(roomKey);
    if (existing) return existing;
    for (const retained of this.retainedByOwner.values()) {
      const ref = retained.get(roomKey);
      if (ref) {
        this.refs.set(roomKey, ref);
        break;
      }
    }
    const session = this.deps.openSession(roomKey);
    this.rooms.set(roomKey, session);
    session.subscribe((snapshot) => {
      if (this.rooms.get(roomKey) !== session) return;
      if (
        snapshot.connectionState?.kind === "reset" ||
        snapshot.connectionState?.kind === "unauthorized" ||
        snapshot.connectionState?.kind === "terminal" ||
        snapshot.status === "destroyed"
      ) {
        this.retire(roomKey, session);
      } else if (this.draining.has(roomKey) && !session.hasUnacknowledgedEdits()) {
        this.retire(roomKey, session);
      }
    });
    return session;
  }

  /** The account runtime is closing: forget every owner and retire every room. */
  invalidate(): void {
    this.retainedByOwner.clear();
    for (const timer of this.teardownTimers.values()) clearTimeout(timer);
    this.teardownTimers.clear();
    const rooms = [...this.rooms];
    for (const [roomKey, session] of rooms) this.retire(roomKey, session, "closed");
    this.refs.clear();
  }

  private reconcile(): void {
    const keep = new Set<string>();
    for (const retained of this.retainedByOwner.values()) {
      for (const roomKey of retained.keys()) keep.add(roomKey);
    }
    // Only `get` and `rebuild` open a room. A release must not: another owner may still retain a
    // room that was just reset, and reopening it would hit the retirement quarantine.
    for (const roomKey of this.rooms.keys()) {
      if (!keep.has(roomKey)) this.scheduleTeardown(roomKey);
    }
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.teardownTimers.has(roomKey) || this.draining.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.teardownTimers.delete(roomKey);
      const session = this.rooms.get(roomKey);
      if (!session || this.isRetained(roomKey)) return;
      if (session.hasUnacknowledgedEdits()) {
        this.draining.add(roomKey);
        return;
      }
      this.retire(roomKey, session);
    }, this.deps.teardownGraceMs);
    this.teardownTimers.set(roomKey, timer);
  }

  private cancelTeardown(roomKey: string): void {
    this.draining.delete(roomKey);
    const timer = this.teardownTimers.get(roomKey);
    if (!timer) return;
    clearTimeout(timer);
    this.teardownTimers.delete(roomKey);
  }

  private isRetained(roomKey: string): boolean {
    for (const retained of this.retainedByOwner.values()) {
      if (retained.has(roomKey)) return true;
    }
    return false;
  }

  private retire(roomKey: string, session: DocumentSession, forced?: "closed"): void {
    if (this.rooms.get(roomKey) !== session) return;
    const disposition = session.resetDisposition;
    const ref = this.refs.get(roomKey);
    const carry = forced ? null : session.unacknowledgedUpdates();
    const room = parseYjsRoomName(roomKey);
    const retirement: BranchRoomRetirement =
      carry &&
      ref &&
      room?.kind === "branch" &&
      (disposition === "superseded" || disposition === "rebuild")
        ? {
            kind: "carried",
            ref,
            disposition,
            source: { roomKey, generation: room.generation },
            carry,
          }
        : {
            kind: "retired",
            roomKey,
            cause:
              forced ??
              disposition ??
              (["unauthorized", "terminal"].includes(
                session.getSnapshot().connectionState?.kind ?? "",
              ) || session.getSnapshot().status === "destroyed"
                ? "closed"
                : "released"),
          };
    this.rooms.delete(roomKey);
    this.refs.delete(roomKey);
    this.cancelTeardown(roomKey);
    // Quarantine is installed before delivery can try to reopen the same room.
    void this.deps.teardownOwner
      .retire({ kind: "branch", roomKey }, session)
      .catch(() => undefined);
    this.deps.retired?.(retirement);
  }
}
