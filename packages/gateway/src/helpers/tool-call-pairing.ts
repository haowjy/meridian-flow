/**
 * Pairs tool results with their calls. A call id is the model's per response, so one id can recur
 * within a turn: a result answers the latest call with its id before it. Feed calls and results in
 * order (message order, or block `sequence` within a turn).
 */
export class ToolCallPairing<C> {
  readonly #latest = new Map<string, { call: C; answered: boolean }>();
  readonly #all: { call: C; answered: boolean }[] = [];

  call(toolCallId: string, call: C): void {
    const entry = { call, answered: false };
    this.#latest.set(toolCallId, entry);
    this.#all.push(entry);
  }

  /** The call this result answers, or undefined when no call with its id came before. */
  answer(toolCallId: string): C | undefined {
    const entry = this.#latest.get(toolCallId);
    if (entry) entry.answered = true;
    return entry?.call;
  }

  /** Every call no result answered, in call order. */
  unanswered(): C[] {
    return this.#all.filter((entry) => !entry.answered).map((entry) => entry.call);
  }
}
