/** Origin-wide derivation intent lock; independent of submission driving. */
export const derivationLockName = (accountId: string, threadId: string) =>
  `meridian:chat-deriving:${accountId}:${threadId}`;

const claims = new Map<string, { release(): void; ready: Promise<void> }>();
/** Acquire at intent creation, not on the first network request. Failures retain the claim. */
export function holdDerivationIntent(
  accountId: string,
  threadId: string,
): Promise<void> | undefined {
  const name = derivationLockName(accountId, threadId);
  const existing = claims.get(name);
  if (existing) return existing.ready;
  if (typeof navigator === "undefined" || !navigator.locks) return;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let grant!: () => void;
  const ready = new Promise<void>((resolve) => {
    grant = resolve;
  });
  const claim = { release, ready };
  claims.set(name, claim);
  const unavailable = (error: unknown) => {
    if (claims.get(name) === claim) claims.delete(name);
    grant();
    reportError(error);
  };
  try {
    void navigator.locks
      .request(name, () => {
        grant();
        return held;
      })
      .catch(unavailable);
  } catch (error) {
    unavailable(error);
  }
  return ready;
}
export function releaseDerivationIntent(accountId: string, threadId: string): void {
  const name = derivationLockName(accountId, threadId);
  claims.get(name)?.release();
  claims.delete(name);
}

export type DerivationWitness = {
  status(threadId: string): "creating" | "failed" | "created" | null;
  /** The callback can re-ask the server while excluding a new derivation. */
  probe<T>(
    threadId: string,
    operation: (pending: boolean, exclusive: boolean) => Promise<T>,
  ): Promise<T>;
};
export function derivationWitness(
  accountId: string,
  status: DerivationWitness["status"],
): DerivationWitness {
  return {
    status,
    async probe(threadId, operation) {
      const pending = () => ["creating", "failed"].includes(status(threadId) ?? "");
      if (pending()) return operation(true, false);
      if (typeof navigator === "undefined" || !navigator.locks) return operation(pending(), false);
      let entered = false;
      try {
        return await navigator.locks.request(
          derivationLockName(accountId, threadId),
          { mode: "exclusive", ifAvailable: true },
          (lock) => {
            entered = true;
            return operation(!lock || pending(), !!lock);
          },
        );
      } catch (error) {
        if (entered) throw error;
        reportError(error);
        return operation(pending(), false);
      }
    },
  };
}
