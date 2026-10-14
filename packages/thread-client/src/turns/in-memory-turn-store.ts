/**
 * A plain `TurnStore` for clients with no UI store (`./mf`): turns per thread,
 * the reducer's event counter, and the snapshot freshness floor (never an event
 * filter: replay coverage is the caller's subscription cursor). It shares its turn
 * operations with the app's store adapter (`turn-ops.ts`); the parity test in
 * the app keeps the two behind one semantics.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import { compareSeq, parseSeq } from "@meridian/contracts/protocol";
import type { TurnStore } from "./reduce-turn-event";
import {
  applySnapshotTo,
  type EnsureAssistantTurnOptions,
  ensureAssistantTurnIn,
  ensureSwitchTurnIn,
  type HeldDividers,
  patchTurnStatusIn,
  removeTurnsIn,
  type SwitchTurnFacts,
  type Tombstones,
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
  private readonly tombstonesByThread = new Map<string, Tombstones>();
  private readonly dividersByThread = new Map<string, HeldDividers>();

  constructor(options: InMemoryTurnStoreOptions) {
    this.now = options.now;
  }

  turns(threadId: string): Turn[] | undefined {
    return this.turnsByThread.get(threadId);
  }

  /**
   * Replaces the thread's turns with a snapshot's and raises the freshness floor
   * to its `nextSeq`. False when the snapshot is older than the accepted floor.
   */
  hydrate(threadId: string, turns: readonly Turn[], nextSeq: string): boolean {
    if (!this.acceptsSnapshot(threadId, nextSeq)) return false;
    const applied = applySnapshotTo(
      {
        tombstones: this.tombstonesByThread.get(threadId) ?? new Map(),
        dividers: this.dividersByThread.get(threadId) ?? new Map(),
      },
      turns,
      nextSeq,
    );
    this.turnsByThread.set(threadId, applied.turns);
    this.tombstonesByThread.set(threadId, applied.tombstones);
    this.dividersByThread.set(threadId, applied.dividers);
    this.floors.set(threadId, nextSeq);
    return true;
  }

  acceptsSnapshot(threadId: string, nextSeq: string): boolean {
    if (parseSeq(nextSeq) === null) return false;
    const floor = this.floors.get(threadId);
    return floor === undefined || compareSeq(nextSeq, floor) >= 0;
  }

  ensureAssistantTurn(threadId: string, turnId: string, opts?: EnsureAssistantTurnOptions): void {
    const existing = this.turnsByThread.get(threadId) ?? [];
    const result = ensureAssistantTurnIn(existing, threadId, turnId, this.now(), opts);
    if (result.kind !== "rejected") this.turnsByThread.set(threadId, result.turns);
  }

  ensureSwitchTurn(threadId: string, facts: SwitchTurnFacts, seq: string): void {
    const state = {
      turns: this.turnsByThread.get(threadId) ?? [],
      dividers: this.dividersByThread.get(threadId) ?? new Map(),
    };
    const next = ensureSwitchTurnIn(state, threadId, facts, seq, this.now());
    if (next === state) return;
    this.turnsByThread.set(threadId, next.turns);
    this.dividersByThread.set(threadId, next.dividers);
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

  removeTurns(threadId: string, ids: readonly string[], seq: string): void {
    const next = removeTurnsIn(
      {
        turns: this.turnsByThread.get(threadId) ?? [],
        tombstones: this.tombstonesByThread.get(threadId) ?? new Map(),
      },
      ids,
      seq,
    );
    this.turnsByThread.set(threadId, next.turns);
    this.tombstonesByThread.set(threadId, next.tombstones);
  }

  bumpEventsApplied(threadId: string): number {
    const next = (this.eventCounts.get(threadId) ?? 0) + 1;
    this.eventCounts.set(threadId, next);
    return next;
  }

  /** No local interrupt-response state to settle. */
  settleInterruptResponse(): void {}
}
