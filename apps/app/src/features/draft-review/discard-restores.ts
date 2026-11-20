/** The documents whose suggestions came back, and whose tree changes came back, by one restore. */
export type RestoredHalves = { text: readonly string[]; tree: readonly string[] };

/** What one restore of a Discard answered (`restorePressDiscard`). */
export type RestoreAnswer = {
  answer: "ok" | "failed" | "gone";
  /** The halves this restore brought back, so an Undo of it takes back those and no more. */
  brought?: RestoredHalves;
};

/** Where one Discard's restore stands in this tab; none until one is sent, and again once one failed. */
export type DiscardRestoreState =
  | { kind: "restoring" }
  | { kind: "restored"; brought: RestoredHalves };

/**
 * The one progress of each Discard's restore, by the Discard's command id, whatever sent it: the
 * notice's Undo or Trash's Restore. Every view reads it here, and a restore already
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
      if (answer.answer === "failed") this.clear(discardCommandId);
      else this.set(discardCommandId, stateOf(answer));
      return answer;
    });
    this.running.set(discardCommandId, answered);
    return answered;
  }

  private clear(discardCommandId: string) {
    this.states.delete(discardCommandId);
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private set(discardCommandId: string, state: DiscardRestoreState) {
    this.states.set(discardCommandId, state);
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

const stateOf = (answer: RestoreAnswer): DiscardRestoreState => ({
  kind: "restored",
  brought: answer.brought ?? { text: [], tree: [] },
});
