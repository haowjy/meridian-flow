const LOCK_PREFIX = "import-upload:";

export type Lease = { release(): void };

export class UploadPresence {
  private readonly leases = new Map<Lease, string>();

  constructor(private readonly announce: () => void) {}

  get working() {
    return this.leases.size > 0;
  }

  holds(importId: string) {
    return [...this.leases.values()].includes(importId);
  }

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

  async othersHolding(): Promise<Set<string>> {
    // A lock released during navigator.locks.query() still appears in the snapshot, so collect this tab's held ids both before and after the query.
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
