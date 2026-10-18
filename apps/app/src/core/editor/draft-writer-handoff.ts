/** Delivers a retired draft's unacknowledged writer updates independently of review UI. */
import { parseYjsRoomName } from "@meridian/contracts/protocol";
import * as Y from "yjs";
import { httpErrorStatus } from "@/client/api/http-client";
import type { DocumentSession, DocumentSessionSnapshot } from "./document-session";
import type { DraftRoomCarry, DraftRoomPool } from "./draft-room-pool";
import { recoverWriterCarry } from "./writer-carry-recovery";
import { rotateWriterClient } from "./writer-client";

type Carry = DraftRoomCarry;
type Entry = { retirement: Carry; attempt: AbortController; delivered: boolean };
type Outcome = "ready" | "retry" | "refused";
export const WRITER_HANDOFF_ORIGIN = Symbol("writer-handoff");

/** Separate integrated bytes from unresolved writer clocks; neither is an acknowledgement. */
function deliverableUpdate(
  document: Y.Doc,
  retirement: Carry,
  retired: boolean,
): {
  update: Uint8Array | null;
  pending: boolean;
  lost: boolean;
} {
  const clone = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
    const updates: Uint8Array[] = [];
    clone.on("update", (update: Uint8Array) => updates.push(update));
    Y.applyUpdate(clone, retirement.carry);
    const pending = clone.store.pendingStructs;
    let lost = false;
    if (pending && retired) {
      const excluded = new Set(
        Y.decodeUpdate(retirement.carry).structs.map((item) => item.id.client),
      );
      excluded.add(document.clientID);
      rotateWriterClient(clone, undefined, excluded);
      lost = recoverWriterCarry(clone, retirement.sourceState, pending.update);
    }
    return {
      update: updates.length ? Y.mergeUpdates(updates) : null,
      pending: pending !== null && !retired,
      lost,
    };
  } finally {
    clone.destroy();
  }
}

export class DraftWriterHandoff {
  private readonly carries = new Map<string, Entry>();
  private sequence = 0;
  private disposed = false;
  constructor(
    private readonly deps: {
      pool: Pick<DraftRoomPool, "retain" | "release" | "rebuild" | "peek">;
      epochSignal: AbortSignal;
      retryDelaysMs: readonly number[];
    },
  ) {
    deps.epochSignal.addEventListener("abort", this.dispose, { once: true });
  }

  carry(retirement: Carry): void {
    if (this.disposed || this.deps.epochSignal.aborted) return;
    const room = parseYjsRoomName(retirement.source.roomKey);
    if (room?.kind !== "draft") throw new Error("Writer carry requires a draft");
    const prior = this.carries.get(room.draftId);
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
              sourceState: Y.mergeUpdates([prior.retirement.sourceState, retirement.sourceState]),
            }
          : retirement,
    };
    this.carries.set(room.draftId, entry);
    entry.retirement.ref.writerChanges?.(entry.retirement.source.generation);
    void this.deliver(room.draftId, entry);
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

  private current(draftId: string, entry: Entry): boolean {
    return (
      !this.disposed &&
      !this.deps.epochSignal.aborted &&
      this.carries.get(draftId) === entry &&
      !entry.attempt.signal.aborted
    );
  }

  private async deliver(draftId: string, entry: Entry): Promise<void> {
    const owner = `writer-handoff:${draftId}:${++this.sequence}`;
    const release = () => this.deps.pool.release(owner);
    entry.attempt.signal.addEventListener("abort", release, { once: true });
    try {
      await this.deliverRetained(draftId, entry, owner);
    } finally {
      entry.attempt.signal.removeEventListener("abort", release);
      release();
    }
  }

  private async deliverRetained(draftId: string, entry: Entry, owner: string): Promise<void> {
    let tries = 0;
    while (this.current(draftId, entry)) {
      let outcome: Outcome = "retry";
      try {
        const roomKey = await entry.retirement.ref.currentRoom();
        if (!this.current(draftId, entry)) return;
        const room = roomKey ? parseYjsRoomName(roomKey) : null;
        if (!roomKey) outcome = "refused";
        else if (
          room?.kind === "draft" &&
          room.draftId === draftId &&
          room.generation >= entry.retirement.source.generation
        ) {
          entry.retirement.ref.writerChanges?.(room.generation);
          this.deps.pool.retain(owner, [{ ...entry.retirement.ref, roomKey }]);
          const session = await this.deps.pool.rebuild(roomKey);
          if (!this.current(draftId, entry)) return;
          outcome = await this.wait(session, entry, false);
          if (!this.current(draftId, entry)) return;
          if (outcome === "ready" && this.deps.pool.peek(roomKey) !== session) outcome = "retry";
          if (outcome === "ready") {
            // No await between filtering and applying: the baseline cannot change underneath it.
            // A synced newer generation is the durable retirement cut. Missing
            // source identities cannot arrive from its fenced-off old journal.
            const { update, pending, lost } = deliverableUpdate(
              session.document,
              entry.retirement,
              room.generation > entry.retirement.source.generation,
            );
            if (lost) entry.retirement.ref.writerLoss?.();
            if (update) {
              const clients = new Set(
                Y.decodeUpdate(entry.retirement.carry).structs.map((s) => s.id.client),
              );
              if (clients.has(session.document.clientID)) {
                rotateWriterClient(session.document, session.presence.adoptDocumentClient, clients);
              }
              // Transfer ownership only when every writer clock integrated. A partial
              // replay must retain the original bytes, including the pending tail.
              entry.delivered = !pending;
              if (!pending) entry.retirement = { ...entry.retirement, carry: update };
              Y.applyUpdate(session.document, update, WRITER_HANDOFF_ORIGIN);
              outcome = await this.wait(session, entry, true);
              if (!this.current(draftId, entry)) return;
              if (outcome === "ready" && this.deps.pool.peek(roomKey) !== session)
                outcome = "retry";
              if (outcome === "ready" && !pending) await entry.retirement.ref.changed();
            }
            // Missing anchors may arrive on a later sync. Never call a carry
            // delivered merely because Yjs emitted no (or only some) updates.
            if (outcome === "ready" && pending) outcome = "retry";
            if (outcome === "ready") {
              if (!this.current(draftId, entry)) return;
              this.carries.delete(draftId);
              entry.retirement.ref.writerChanges?.(null);
              return;
            }
          }
        }
      } catch (error) {
        const status = httpErrorStatus(error);
        if (status === 401 || status === 403 || status === 404) outcome = "refused";
      }
      if (!this.current(draftId, entry)) return;
      if (outcome === "refused" || entry.delivered) {
        this.carries.delete(draftId);
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
