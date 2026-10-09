/** Delivers a retired branch's unacknowledged writer updates independently of review UI. */
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import { httpErrorStatus } from "@/client/api/http-client";
import type { BranchRoomCarry, BranchRoomPool } from "./branch-room-pool";
import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";
import { rotateWriterClient } from "./writer-client";

type Carry = BranchRoomCarry;
type Entry = { retirement: Carry; attempt: AbortController; delivered: boolean };
type Outcome = "ready" | "retry" | "refused";
export const WRITER_HANDOFF_ORIGIN = Symbol("writer-handoff");

/** Only updates integrated against the synced baseline, not inherited tombstones or pending structs. */
export function deliverableUpdate(document: Y.Doc, carry: Uint8Array): Uint8Array | null {
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
    const updates: Uint8Array[] = [];
    clone.on("update", (update: Uint8Array) => updates.push(update));
    Y.applyUpdate(clone, carry);
    return updates.length ? Y.mergeUpdates(updates) : null;
  } finally {
    clone.destroy();
  }
}

export class BranchWriterHandoff {
  private readonly carries = new Map<string, Entry>();
  private sequence = 0;
  private disposed = false;
  constructor(
    private readonly deps: {
      pool: Pick<BranchRoomPool, "retain" | "release" | "rebuild" | "peek">;
      epochSignal: AbortSignal;
      retryDelaysMs: readonly number[];
    },
  ) {
    deps.epochSignal.addEventListener("abort", this.dispose, { once: true });
  }

  carry(retirement: Carry): void {
    if (this.disposed || this.deps.epochSignal.aborted) return;
    const room = parseYjsRoomName(retirement.source.roomKey);
    if (room?.kind !== "branch") throw new Error("Writer carry requires a branch");
    const prior = this.carries.get(room.branchId);
    prior?.attempt.abort();
    const entry: Entry = {
      attempt: new AbortController(),
      delivered: false,
      retirement:
        prior && !prior.delivered
          ? {
              ...retirement,
              source:
                prior.retirement.source.generation > retirement.source.generation
                  ? prior.retirement.source
                  : retirement.source,
              carry: Y.mergeUpdates([prior.retirement.carry, retirement.carry]),
            }
          : retirement,
    };
    this.carries.set(room.branchId, entry);
    entry.retirement.ref.writerChanges?.(entry.retirement.source.generation);
    void this.deliver(room.branchId, entry);
  }

  dispose = (): void => {
    this.disposed = true;
    this.deps.epochSignal.removeEventListener("abort", this.dispose);
    for (const entry of this.carries.values()) {
      entry.attempt.abort();
      entry.retirement.ref.writerChanges?.(null);
    }
    this.carries.clear();
  };

  private current(branchId: string, entry: Entry): boolean {
    return (
      !this.disposed &&
      !this.deps.epochSignal.aborted &&
      this.carries.get(branchId) === entry &&
      !entry.attempt.signal.aborted
    );
  }

  private async deliver(branchId: string, entry: Entry): Promise<void> {
    let tries = 0;
    while (this.current(branchId, entry)) {
      const owner = `writer-handoff:${branchId}:${++this.sequence}`;
      // Abort releases synchronously, even if an HTTP read or rebuild never settles.
      const release = () => this.deps.pool.release(owner);
      entry.attempt.signal.addEventListener("abort", release, { once: true });
      let outcome: Outcome = "retry";
      try {
        const roomKey = await entry.retirement.ref.currentRoom();
        if (!this.current(branchId, entry)) return;
        const room = roomKey ? parseYjsRoomName(roomKey) : null;
        if (!roomKey) outcome = "refused";
        else if (
          room?.kind === "branch" &&
          room.branchId === branchId &&
          room.generation >= entry.retirement.source.generation
        ) {
          entry.retirement.ref.writerChanges?.(room.generation);
          this.deps.pool.retain(owner, [{ ...entry.retirement.ref, roomKey }]);
          const session = await this.deps.pool.rebuild(roomKey);
          if (!this.current(branchId, entry)) return;
          outcome = await this.wait(session, entry, false);
          if (!this.current(branchId, entry)) return;
          if (outcome === "ready" && this.deps.pool.peek(roomKey) !== session) outcome = "retry";
          if (outcome === "ready") {
            // No await between filtering and applying: the baseline cannot change underneath it.
            const update = deliverableUpdate(session.document, entry.retirement.carry);
            if (update) {
              const clients = new Set(
                Y.decodeUpdate(entry.retirement.carry).structs.map((s) => s.id.client),
              );
              if (clients.has(session.document.clientID)) {
                rotateWriterClient(session.document, session.presence.adoptDocumentClient, clients);
              }
              // The successor outbox owns the filtered bytes now. A later retirement must
              // not merge the original's discarded anchors back into the next carry.
              entry.delivered = true;
              entry.retirement = { ...entry.retirement, carry: update };
              Y.applyUpdate(session.document, update, WRITER_HANDOFF_ORIGIN);
              outcome = await this.wait(session, entry, true);
              if (!this.current(branchId, entry)) return;
              if (outcome === "ready" && this.deps.pool.peek(roomKey) !== session)
                outcome = "retry";
              if (outcome === "ready") await entry.retirement.ref.changed();
            }
            if (outcome === "ready") {
              if (!this.current(branchId, entry)) return;
              this.carries.delete(branchId);
              entry.retirement.ref.writerChanges?.(null);
              return;
            }
          }
        }
      } catch (error) {
        const status = httpErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) outcome = "refused";
      } finally {
        entry.attempt.signal.removeEventListener("abort", release);
        release();
      }
      if (!this.current(branchId, entry)) return;
      if (outcome === "refused" || entry.delivered) {
        this.carries.delete(branchId);
        entry.retirement.ref.writerChanges?.(null);
        return;
      }
      const delays = this.deps.retryDelaysMs;
      await this.delay(delays[Math.min(tries++, delays.length - 1)] ?? 1_000, entry.attempt.signal);
    }
  }

  private wait(session: DocumentSession, entry: Entry, acknowledgement: boolean): Promise<Outcome> {
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      let settled = false;
      const finish = (outcome: Outcome) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        entry.attempt.signal.removeEventListener("abort", aborted);
        resolve(outcome);
      };
      const aborted = () => finish("refused");
      const inspect = (snapshot: DocumentSessionSnapshot) => {
        const connection = snapshot.connectionState;
        if (connection?.kind === "reset") {
          finish(
            connection.disposition === "superseded" || connection.disposition === "rebuild"
              ? "retry"
              : "refused",
          );
        } else if (
          snapshot.access === "read" ||
          connection?.kind === "unauthorized" ||
          connection?.kind === "terminal"
        ) {
          finish("refused");
        } else if (snapshot.status === "destroyed") finish("retry");
        else if (
          snapshot.status === "synced" &&
          snapshot.access === "edit" &&
          (!acknowledgement || snapshot.serverHasLocalChanges)
        )
          finish("ready");
      };
      entry.attempt.signal.addEventListener("abort", aborted, { once: true });
      unsubscribe = session.subscribe(inspect);
      if (settled) unsubscribe();
      if (entry.attempt.signal.aborted) aborted();
    });
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
