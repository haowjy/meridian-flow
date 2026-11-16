/**
 * The session registry's stable draft (review) rooms: retained per
 * owner, torn down after a grace period once no owner holds them, retired when
 * they reset, and rebuilt on request. Draft rooms hold no lease. Retaining and
 * releasing only record ownership; a room opens on `get` or `rebuild`.
 *
 * A closed room keeps its local copy: a Discard can be undone, so the copy goes with its document
 * (`LocalDocumentCopies`), never with the room. It stays closed until a restore reopens it; a
 * reader that comes to it meanwhile reads the session an owner still shows, if one does.
 *
 * A room whose updates the server kept refusing (`updatesRefused`), or whose draft the server
 * closed (`draftClosed`: it is in Trash), is not retired on that close: it stays open, read-only,
 * so its owner can show its text, until the owner rebuilds it (a restore reopened the draft) or
 * the last owner leaves, when it retires without the grace.
 */

import { parseYjsRoomName } from "@meridian/contracts/protocol";
import { type DocumentSession, draftClosed, updatesRefused } from "./document-session";
import type { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";
import type { CopyHold } from "./local-document-copies";

/** A draft room and the document it drafts: the room's copy is kept under the document, and goes with it. */
export type DraftRoomRef = { roomKey: string; documentId: string };

export class DraftRoomPool {
  private readonly closed = new Set<string>();
  private readonly draining = new Set<string>();
  private readonly rooms = new Map<string, DocumentSession>();
  private readonly documents = new Map<string, string>();
  private readonly holds = new Map<string, Promise<CopyHold>>();
  private readonly retainedByOwner = new Map<string, Set<string>>();
  private readonly teardownTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      /**
       * A new session for the room, published to its observers with its transport attached, and
       * the shared hold on its local copy, taken while the session is open.
       */
      open(
        roomKey: string,
        documentId: string,
        replaced?: { session: DocumentSession; hold: Promise<CopyHold> | null | undefined },
      ): { session: DocumentSession; hold: Promise<CopyHold> };
      teardownOwner: DocumentSessionTeardownOwner;
      teardownGraceMs: number;
    },
  ) {}

  sessions(): DocumentSession[] {
    return [...this.rooms.values()];
  }

  peek(roomKey: string): DocumentSession | undefined {
    return this.rooms.get(roomKey);
  }

  /** The document a retained room drafts; it stays known after the room retires. */
  documentOf(roomKey: string): string | undefined {
    return this.documents.get(roomKey);
  }

  retain(ownerId: string, rooms: readonly DraftRoomRef[]): void {
    const keys = new Set<string>();
    for (const { roomKey, documentId } of rooms) {
      if (parseYjsRoomName(roomKey)?.kind !== "draft") {
        throw new Error(`Draft retention requires a draft room: ${roomKey}`);
      }
      keys.add(roomKey);
      this.documents.set(roomKey, documentId);
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
    const kept = this.rooms.get(roomKey);
    if (kept && keptForOwner(kept)) this.retire(roomKey, kept);
    // A reset draft session is already retired; wait out its teardown quarantine.
    await this.deps.teardownOwner.drainRoom({ kind: "draft", roomKey });
    // The last owner can leave while the drain waits. Reopening then would start a session
    // nothing owns and nothing would ever tear down.
    if (!this.isRetained(roomKey)) throw new Error(`Draft room was released: ${roomKey}`);
    return this.get(roomKey);
  }

  get(roomKey: string): DocumentSession {
    const existing = this.rooms.get(roomKey);
    // A closed room an owner still shows is read as it is shown, and joins its reopening with it.
    if (this.closed.has(roomKey) && !existing) throw new Error(`Draft room closed: ${roomKey}`);
    const room = parseYjsRoomName(roomKey);
    if (room?.kind !== "draft") throw new Error(`Draft session requires a draft room: ${roomKey}`);
    this.cancelTeardown(roomKey);
    this.deps.teardownOwner.assertAvailable({ kind: "draft", roomKey });
    if (existing) return existing;
    const documentId = this.documents.get(roomKey);
    if (!documentId) throw new Error(`Draft room was never retained: ${roomKey}`);
    const { session, hold } = this.deps.open(roomKey, documentId);
    this.holds.set(roomKey, hold);
    this.rooms.set(roomKey, session);
    this.watch(roomKey, session);
    return session;
  }

  private watch(roomKey: string, session: DocumentSession): void {
    session.subscribe(() => {
      if (this.rooms.get(roomKey) !== session) return;
      if (keptForOwner(session)) {
        if (!this.isRetained(roomKey)) this.retire(roomKey, session);
      } else if (session.isRoomEnded()) {
        this.retire(roomKey, session);
      } else if (
        this.draining.has(roomKey) &&
        (!session.hasUnacknowledgedEdits() || !session.canDeliverUnsentEdits())
      ) {
        this.retire(roomKey, session);
      }
    });
  }

  /**
   * A session on the room's next incarnation takes the room, read-only like the one it replaces,
   * which retires once its editors have gone. Null when `session` is not the room's any more.
   */
  replace(roomKey: string, session: DocumentSession): DocumentSession | null {
    if (this.rooms.get(roomKey) !== session) return null;
    const documentId = this.documents.get(roomKey);
    if (!documentId) throw new Error(`Draft room was never retained: ${roomKey}`);
    const { session: next, hold } = this.deps.open(roomKey, documentId, {
      session,
      hold: this.holds.get(roomKey),
    });
    this.holds.set(roomKey, hold);
    this.rooms.set(roomKey, next);
    this.watch(roomKey, next);
    return next;
  }

  /** An authoritative close can arrive by metadata before the socket's terminal frame. */
  async close(roomKey: string): Promise<void> {
    this.closed.add(roomKey);
    const session = this.rooms.get(roomKey);
    // An owner still showing it keeps it, read-only, as the socket's own close would.
    if (session && this.isRetained(roomKey)) session.endClosed();
    if (session && !(keptForOwner(session) && this.isRetained(roomKey)))
      this.retire(roomKey, session);
    await this.deps.teardownOwner.drainRoom({ kind: "draft", roomKey });
  }

  /**
   * A restore reopened the draft: the next `get` opens its room again. Returns the closed session
   * an owner still shows, for its transport to restart in place.
   */
  reopen(roomKey: string): DocumentSession | null {
    this.closed.delete(roomKey);
    const session = this.rooms.get(roomKey);
    return session && draftClosed(session.getSnapshot().connectionState) ? session : null;
  }

  /** The account runtime is closing: forget every owner and retire every room. */
  invalidate(): void {
    this.retainedByOwner.clear();
    for (const timer of this.teardownTimers.values()) clearTimeout(timer);
    this.teardownTimers.clear();
    const rooms = [...this.rooms];
    for (const [roomKey, session] of rooms) this.retire(roomKey, session);
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
    const kept = this.rooms.get(roomKey);
    // A room kept only for its owner never reopens, and its retirement hands back the typing
    // that just left the screen, so it waits only for a host remounting in the same commit.
    const graceMs = kept && keptForOwner(kept) ? 0 : this.deps.teardownGraceMs;
    const timer = setTimeout(() => {
      this.teardownTimers.delete(roomKey);
      const session = this.rooms.get(roomKey);
      if (!session || this.isRetained(roomKey)) return;
      if (session.hasUnacknowledgedEdits() && session.canDeliverUnsentEdits()) {
        this.draining.add(roomKey);
        return;
      }
      this.retire(roomKey, session);
    }, graceMs);
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

  private retire(roomKey: string, session: DocumentSession): void {
    if (this.rooms.get(roomKey) !== session) return;
    this.rooms.delete(roomKey);
    this.cancelTeardown(roomKey);
    // Quarantine is installed before delivery can try to reopen the same room.
    const hold = this.holds.get(roomKey);
    this.holds.delete(roomKey);
    void this.deps.teardownOwner
      .retire({ kind: "draft", roomKey }, session)
      .catch((error: unknown) => reportError(error))
      .then(async () => (await hold)?.release());
  }
}

/** A room ended in a way its owner still shows, read-only: refused updates, or a closed draft. */
function keptForOwner(session: DocumentSession): boolean {
  const { connectionState } = session.getSnapshot();
  return updatesRefused(connectionState) || draftClosed(connectionState);
}
