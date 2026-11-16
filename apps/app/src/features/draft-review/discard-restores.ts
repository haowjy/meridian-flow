import type { RestoreReturned } from "./draft-notices";

/** What one restore of a Discard answered (`restoreDiscard`). */
export type RestoreAnswer = {
  answer: "ok" | "failed" | "gone" | "returned";
  /** What the Discard held that could not come back. */
  leftOut?: number;
  why?: RestoreReturned;
  /** The Work's current branch, where the drafts came back. */
  branchId?: string;
};

/** Where one Discard's restore stands in this tab; none until one is sent. */
export type DiscardRestoreState =
  | { kind: "restoring" }
  /** `branchId` absent: it was already back. */
  | { kind: "restored"; branchId?: string; leftOut: number }
  /** Nothing came back: Live's text was edited over every change. The entry stays in Trash. */
  | { kind: "left_out"; leftOut: number }
  | { kind: "returned"; why: RestoreReturned }
  | { kind: "failed" };

/**
 * The one progress of each Discard's restore, by the Discard's command id, whatever sent it: the
 * notice's Undo, Trash's Restore or the editor's. Every view reads it here, and a restore already
 * under way is joined, not sent again.
 */
export class DiscardRestores {
  private readonly states = new Map<string, DiscardRestoreState>();
  private readonly running = new Map<string, Promise<RestoreAnswer>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;

  state(discardCommandId: string): DiscardRestoreState | undefined {
    return this.states.get(discardCommandId);
  }

  restore(discardCommandId: string, send: () => Promise<RestoreAnswer>): Promise<RestoreAnswer> {
    const under = this.running.get(discardCommandId);
    if (under) return under;
    this.set(discardCommandId, { kind: "restoring" });
    const answered = send().then((answer) => {
      this.running.delete(discardCommandId);
      this.set(discardCommandId, stateOf(answer));
      return answer;
    });
    this.running.set(discardCommandId, answered);
    return answered;
  }

  private set(discardCommandId: string, state: DiscardRestoreState) {
    this.states.set(discardCommandId, state);
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

const stateOf = (answer: RestoreAnswer): DiscardRestoreState =>
  answer.answer === "gone" && answer.leftOut
    ? { kind: "left_out", leftOut: answer.leftOut }
    : answer.answer === "ok" || answer.answer === "gone"
      ? {
          kind: "restored",
          leftOut: answer.leftOut ?? 0,
          ...(answer.branchId ? { branchId: answer.branchId } : {}),
        }
      : answer.answer === "returned" && answer.why
        ? { kind: "returned", why: answer.why }
        : { kind: "failed" };
