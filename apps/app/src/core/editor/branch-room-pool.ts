/**
 * The session registry's generation-fenced branch (review) rooms: retained per
 * owner, torn down after a grace period once no owner holds them, retired when
 * they reset, and rebuilt on request. Branch rooms hold no lease. Retaining and
 * releasing only record ownership; a room opens on `get` or `rebuild`.
 */
import { parseYjsRoomName } from "@meridian/contracts/protocol";

import type { DocumentSession } from "./document-session";
import type { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

export class BranchRoomPool {
  private readonly rooms = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Set<string>>();
  private readonly teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      /** A new session for the room, published to its observers with its transport attached. */
      openSession(roomKey: string): DocumentSession;
      teardownOwner: DocumentSessionTeardownOwner;
      teardownGraceMs: number;
    },
  ) {}

  peek(roomKey: string): DocumentSession | undefined {
    return this.rooms.get(roomKey);
  }

  retain(ownerId: string, roomKeys: Iterable<string>): void {
    const keys = new Set(roomKeys);
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "branch") {
        throw new Error(`Branch retention requires a branch room: ${roomKey}`);
      }
    }
    this.retainedByOwner.set(ownerId, keys);
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
    const session = this.deps.openSession(roomKey);
    session.subscribe((snapshot) => {
      if (snapshot.connectionState?.kind !== "reset") return;
      if (this.rooms.get(roomKey) !== session) return;
      this.rooms.delete(roomKey);
      void this.retire(roomKey, session);
    });
    this.rooms.set(roomKey, session);
    return session;
  }

  /** The account runtime is closing: forget every owner and retire every room. */
  invalidate(): void {
    this.retainedByOwner.clear();
    for (const timer of this.teardownTimers.values()) clearTimeout(timer);
    this.teardownTimers.clear();
    const rooms = [...this.rooms];
    this.rooms.clear();
    for (const [roomKey, session] of rooms) void this.retire(roomKey, session);
  }

  private reconcile(): void {
    const keep = new Set<string>();
    for (const retained of this.retainedByOwner.values()) {
      for (const roomKey of retained) keep.add(roomKey);
    }
    // Only `get` and `rebuild` open a room. A release must not: another owner may still retain a
    // room that was just reset, and reopening it would hit the retirement quarantine.
    for (const roomKey of this.rooms.keys()) {
      if (!keep.has(roomKey)) this.scheduleTeardown(roomKey);
    }
  }

  private scheduleTeardown(roomKey: string): void {
    if (this.teardownTimers.has(roomKey)) return;
    const timer = setTimeout(() => {
      this.teardownTimers.delete(roomKey);
      const session = this.rooms.get(roomKey);
      if (!session || this.isRetained(roomKey)) return;
      this.rooms.delete(roomKey);
      void this.retire(roomKey, session);
    }, this.deps.teardownGraceMs);
    this.teardownTimers.set(roomKey, timer);
  }

  private cancelTeardown(roomKey: string): void {
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

  private retire(roomKey: string, session: DocumentSession): Promise<void> {
    return this.deps.teardownOwner
      .retire({ kind: "branch", roomKey }, session)
      .catch(() => undefined);
  }
}
