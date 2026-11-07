/**
 * Upload presence: a tab holds the Web Lock `import-upload:<id>` for exactly as long as one of its
 * leases on that import is alive. A lock table survives what a timer heartbeat cannot (throttled
 * background tabs, crashes, discarded tabs), and a release is the only "tab gone" signal.
 * Without Web Locks (an insecure context) nothing is held and other tabs simply offer Continue.
 */
const LOCK_PREFIX = "import-upload:";

export type Lease = { release(): void };

export class UploadPresence {
  private readonly leases = new Map<Lease, string>();

  /** `announce` tells other tabs that some lock changed; the lock table is still the truth. */
  constructor(private readonly announce: () => void) {}

  /** This tab holds, or waits to hold, a lock: it is reading, creating, sending or hashing files. */
  get working() {
    return this.leases.size > 0;
  }

  holds(importId: string) {
    return [...this.leases.values()].includes(importId);
  }

  /** Request the import's lock until the lease is released. A queued request counts as held. */
  hold(importId: string): Lease {
    let drop!: () => void;
    const released = new Promise<void>((resolve) => {
      drop = resolve;
    });
    const lease: Lease = {
      release: () => {
        if (this.leases.delete(lease)) drop();
      },
    };
    this.leases.set(lease, importId);
    void navigator.locks
      ?.request(`${LOCK_PREFIX}${importId}`, () => {
        this.announce();
        return released;
      })
      .then(() => this.announce());
    return lease;
  }

  /** Imports whose upload lock a tab other than this one holds. */
  async othersHolding(): Promise<Set<string>> {
    // A lock this tab released while the query ran still shows in the snapshot, so skip every
    // import it held at either end.
    const mine = new Set(this.leases.values());
    const snapshot = await navigator.locks?.query();
    for (const importId of this.leases.values()) mine.add(importId);
    return new Set(
      (snapshot?.held ?? []).flatMap(({ name }) => {
        const importId = name?.startsWith(LOCK_PREFIX) ? name.slice(LOCK_PREFIX.length) : null;
        return importId && !mine.has(importId) ? [importId] : [];
      }),
    );
  }
}
