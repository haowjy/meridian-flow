/**
 * A plain `TurnStore` for clients with no UI store (`./mf`): turns per thread,
 * the reducer's event counter, and the snapshot floor. It shares its turn
 * operations with the app's store adapter (`turn-ops.ts`); the parity test in
 * the app keeps the two behind one semantics.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { compareSeq, parseSeq } from "@meridian/contracts/protocol";
import type { TurnStore } from "./reduce-turn-event";
import {
  type EnsureAssistantTurnOptions,
  ensureAssistantTurnIn,
  patchTurnStatusIn,
  type TurnStatusPatch,
  upsertBlockIn,
} from "./turn-ops";

export type InMemoryTurnStoreOptions = {
  /** ISO-8601 timestamp for turns created without an explicit `createdAt`. */
  now: () => string;
};

export class InMemoryTurnStore implements TurnStore {
  private readonly now: () => string;
  private readonly turnsByThread = new Map<string, Turn[]>();
  private readonly eventCounts = new Map<string, number>();
  private readonly floors = new Map<string, string>();

  constructor(options: InMemoryTurnStoreOptions) {
    this.now = options.now;
  }

  turns(threadId: string): Turn[] | undefined {
    return this.turnsByThread.get(threadId);
  }

  /** The lowest event seq the store has not yet covered; undefined before any hydrate or event. */
  nextSeq(threadId: string): string | undefined {
    return this.floors.get(threadId);
  }

  /**
   * Replaces the thread's turns with a snapshot's and raises the floor to its
   * `nextSeq`. False when the snapshot is older than the accepted floor.
   */
  hydrate(threadId: string, turns: readonly Turn[], nextSeq: string): boolean {
    if (!this.acceptsSnapshot(threadId, nextSeq)) return false;
    this.turnsByThread.set(threadId, [...turns]);
    this.floors.set(threadId, nextSeq);
    return true;
  }

  acceptsSnapshot(threadId: string, nextSeq: string): boolean {
    if (parseSeq(nextSeq) === null) return false;
    const floor = this.floors.get(threadId);
    return floor === undefined || compareSeq(nextSeq, floor) >= 0;
  }

  /**
   * Admits one sequenced event: false when the hydrated snapshot or an earlier
   * event already covers it. Accepting raises the floor to `seq + 1`.
   */
  acceptEventSeq(threadId: string, seq: string): boolean {
    if (parseSeq(seq) === null) return false;
    const floor = this.floors.get(threadId);
    if (floor !== undefined && compareSeq(seq, floor) < 0) return false;
    this.floors.set(threadId, (BigInt(seq) + 1n).toString());
    return true;
  }

  ensureAssistantTurn(threadId: string, turnId: string, opts?: EnsureAssistantTurnOptions): void {
    const existing = this.turnsByThread.get(threadId) ?? [];
    const result = ensureAssistantTurnIn(existing, threadId, turnId, this.now(), opts);
    if (result.kind !== "rejected") this.turnsByThread.set(threadId, result.turns);
  }

  upsertAssistantBlock(threadId: string, turnId: string, block: Block): void {
    const next = upsertBlockIn(this.turnsByThread.get(threadId) ?? [], turnId, block);
    if (next) this.turnsByThread.set(threadId, next);
  }

  patchTurnStatus(
    threadId: string,
    turnId: string,
    status: Turn["status"],
    patch?: TurnStatusPatch,
  ): void {
    const next = patchTurnStatusIn(this.turnsByThread.get(threadId) ?? [], turnId, status, patch);
    if (next) this.turnsByThread.set(threadId, next);
  }

  bumpEventsApplied(threadId: string): number {
    const next = (this.eventCounts.get(threadId) ?? 0) + 1;
    this.eventCounts.set(threadId, next);
    return next;
  }

  /** No local interrupt-response state to settle. */
  settleInterruptResponse(): void {}
}
