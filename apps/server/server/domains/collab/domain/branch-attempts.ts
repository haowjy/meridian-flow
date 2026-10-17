/**
 * The one owner of a bounded branch-store attempt (decision D13): capture and compute off
 * every lock, one commit scope per attempt, and the lifetime of every candidate the attempt
 * prepared. Operation policy (the bound's exhaustion outcome, a frame's locked last attempt,
 * the inverse's classification pass, the reply save's retained `confirm` locks) stays with
 * the caller.
 */

/**
 * The attempt's rollback boundary: a root transaction, or inside an ambient one a single
 * savepoint. Rolling it back releases every lock the attempt took inside it.
 */
export type AttemptScope = <R>(operation: () => Promise<R>) => Promise<R>;

/**
 * Something an attempt prepared that only its success may keep: `transfer` hands it to
 * publication once the whole attempt completed, `dispose` drops it on any unwind, including
 * one whose own write succeeded inside a scope that a later miss rolled back.
 */
export type AttemptCandidate = {
  transfer(): void | Promise<void>;
  dispose(): void;
};

export type Attempt = {
  /** 1-based. */
  readonly number: number;
  /** The bound's final attempt: its miss is the caller's exhaustion outcome. */
  readonly last: boolean;
  /** Owns `candidate` until the attempt completes: transferred then, disposed on an unwind. */
  own<C extends AttemptCandidate>(candidate: C): C;
  /**
   * Runs `operation` inside the attempt's one commit scope, which it opens before the
   * attempt's first branch-store lock. A throw leaves the scope (rolled back) before the
   * attempt is classified, so a retry never computes under the failed attempt's locks.
   */
  commit<R>(operation: () => Promise<R>): Promise<R>;
};

export const NO_ATTEMPT_SCOPE: AttemptScope = (operation) => operation();

/**
 * Runs `run` up to `bound` times. A throw `isMiss` accepts unwinds the attempt (its scope
 * rolled back, its candidates disposed) and runs the next one from a fresh capture; after
 * the last, `exhausted` answers with the caller's policy. Any other throw unwinds and
 * propagates. A completed attempt transfers its candidates in the order it owned them.
 */
export async function runBoundedAttempts<T>(spec: {
  bound: number;
  scope: AttemptScope;
  isMiss(cause: unknown): boolean;
  run(attempt: Attempt): Promise<T>;
  exhausted(cause: unknown): T | Promise<T>;
  /** A miss is about to be retried as attempt `next`. */
  retrying?(next: number): void;
}): Promise<T> {
  for (let number = 1; ; number++) {
    const owned: AttemptCandidate[] = [];
    let scoped = false;
    const attempt: Attempt = {
      number,
      last: number >= spec.bound,
      own(candidate) {
        owned.push(candidate);
        return candidate;
      },
      commit(operation) {
        if (scoped) throw new Error("An attempt has exactly one commit scope");
        scoped = true;
        return spec.scope(operation);
      },
    };
    let result: T;
    try {
      result = await spec.run(attempt);
    } catch (cause) {
      disposeAll(owned);
      if (!spec.isMiss(cause)) throw cause;
      if (attempt.last) return spec.exhausted(cause);
      spec.retrying?.(number + 1);
      continue;
    }
    for (const [index, candidate] of owned.entries()) {
      try {
        await candidate.transfer();
      } catch (cause) {
        disposeAll(owned.slice(index + 1));
        throw cause;
      }
    }
    return result;
  }
}

function disposeAll(candidates: readonly AttemptCandidate[]): void {
  for (const candidate of candidates) candidate.dispose();
}
