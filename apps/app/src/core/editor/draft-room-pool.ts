/**
 * The session registry's generation-fenced draft (review) rooms: retained per
 * owner, torn down after a grace period once no owner holds them, retired when
 * they reset, and rebuilt on request. Draft rooms hold no lease. Retaining and
 * releasing only record ownership; a room opens on `get` or `rebuild`.
 *
 * A room whose updates the server kept refusing (`updatesRefused`) is not
 * retired on that close: it stays open, read-only, so its owner can show the
 * unsent text, until the owner rebuilds it or the last owner leaves.
 */

import { parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";

import { type DocumentSession, updatesRefused } from "./document-session";
import type { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

export type DraftRoomRef = Readonly<{
  roomKey: string;
  currentRoom(): Promise<string | null>;
  changed(): void | Promise<void>;
  writerChanges?(generation: number | null): void;
  writerLoss?(): void;
}>;
export type DraftRoomCarry = Readonly<{
  ref: DraftRoomRef;
  source: { roomKey: string; generation: number };
  carry: Uint8Array;
  sourceState: Uint8Array;
}>;

export class DraftRoomPool {
  private readonly refs = new Map<string, DraftRoomRef>();
  private readonly draining = new Set<string>();
  private readonly rooms = new Map<string, DocumentSession>();
  private readonly retainedByOwner = new Map<string, Map<string, DraftRoomRef>>();
  private readonly teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      /** A new session for the room, published to its observers with its transport attached. */
      openSession(roomKey: string): DocumentSession;
      teardownOwner: DocumentSessionTeardownOwner;
      teardownGraceMs: number;
      carry?(carry: DraftRoomCarry): void;
    },
  ) {}

  peek(roomKey: string): DocumentSession | undefined {
    return this.rooms.get(roomKey);
  }

  retain(ownerId: string, refs: readonly DraftRoomRef[]): void {
    const keys = new Set(refs.map((ref) => ref.roomKey));
    for (const roomKey of keys) {
      if (parseYjsRoomName(roomKey)?.kind !== "draft") {
        throw new Error(`Draft retention requires a draft room: ${roomKey}`);
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
    const refused = this.rooms.get(roomKey);
    if (refused && updatesRefused(refused.getSnapshot().connectionState))
      this.retire(roomKey, refused);
    // A reset draft session is already retired; wait out its teardown quarantine.
    await this.deps.teardownOwner.drainRoom({ kind: "draft", roomKey });
    // The last owner can leave while the drain waits. Reopening then would start a session
    // nothing owns and nothing would ever tear down.
    if (!this.isRetained(roomKey)) throw new Error(`Draft room was released: ${roomKey}`);
    return this.get(roomKey);
  }

  get(roomKey: string): DocumentSession {
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "draft") throw new Error(`Draft session requires a draft room: ${roomKey}`);
    this.cancelTeardown(roomKey);
    this.deps.teardownOwner.assertAvailable({ kind: "draft", roomKey });
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
      if (updatesRefused(snapshot.connectionState)) {
        if (!this.isRetained(roomKey)) this.retire(roomKey, session);
      } else if (
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
    for (const [roomKey, session] of rooms) this.retire(roomKey, session, true);
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
      if (
        session.hasUnacknowledgedEdits() &&
        !updatesRefused(session.getSnapshot().connectionState)
      ) {
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

  private retire(roomKey: string, session: DocumentSession, closing = false): void {
    if (this.rooms.get(roomKey) !== session) return;
    const disposition = session.resetDisposition;
    const ref = this.refs.get(roomKey);
    const carry = closing ? null : session.unacknowledgedUpdates();
    const room = parseYjsRoomName(roomKey);
    const retirement: DraftRoomCarry | null =
      carry &&
      ref &&
      room?.kind === "draft" &&
      (disposition === "superseded" || disposition === "rebuild")
        ? {
            ref,
            source: { roomKey, generation: room.generation },
            carry,
            sourceState: Y.encodeStateAsUpdate(session.document),
          }
        : null;
    this.rooms.delete(roomKey);
    this.refs.delete(roomKey);
    this.cancelTeardown(roomKey);
    // Quarantine is installed before delivery can try to reopen the same room.
    void this.deps.teardownOwner.retire({ kind: "draft", roomKey }, session).catch(() => undefined);
    if (retirement) this.deps.carry?.(retirement);
  }
}
