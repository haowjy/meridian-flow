/**
 * The catalog handoff for one import: which of its node ids the catalog has ever
 * held (`seen`) and which materialized rows this tab keeps drawing until the
 * catalog shows them (`bridges`). Bridges open as a batch, deadlines live in one
 * map and one timer waits for the next of them, so a 10,000-row plan costs one
 * timer and one publication per batch, not one per node.
 */

/** How long a materialized row stays drawn while waiting for the catalog to show it. */
const BRIDGE_MS = 30_000;

/** The catalog, as the handoff needs it: whether it holds a node id now, and when it changes. */
export type CatalogReader = {
  holds(id: string): boolean;
  subscribe(listener: () => void): () => void;
};

export type Clock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export class Handoff {
  /** Node ids the catalog has held while this tab tracked the import. */
  seen: ReadonlySet<string> = new Set();
  /** Node ids drawn on a deadline; replaced, never mutated, when it changes. */
  bridges: ReadonlySet<string> = new Set();
  /** Tracked ids the catalog has not held yet. */
  private readonly unseen = new Set<string>();
  private readonly deadlines = new Map<string, number>();
  private timer: unknown;

  constructor(
    private readonly catalog: CatalogReader,
    private readonly clock: Clock,
    /** Called once per batch of bridges that ran out. */
    private readonly onExpired: () => void,
  ) {}

  /** Whether any bridge is still open. */
  get bridging(): boolean {
    return this.deadlines.size > 0;
  }

  /** Remember node ids to watch the catalog for; true when the catalog already held some. */
  track(ids: Iterable<string>): boolean {
    for (const id of ids) if (!this.seen.has(id)) this.unseen.add(id);
    return this.scan();
  }

  /** Move every tracked id the catalog now holds into `seen` and close its bridge; true when any moved. */
  scan(): boolean {
    if (this.unseen.size === 0) return false;
    const added: string[] = [];
    for (const id of this.unseen) if (this.catalog.holds(id)) added.push(id);
    if (added.length === 0) return false;
    let closed = false;
    for (const id of added) {
      this.unseen.delete(id);
      closed = this.deadlines.delete(id) || closed;
    }
    this.seen = new Set([...this.seen, ...added]);
    if (closed) this.bridges = new Set(this.deadlines.keys());
    if (this.deadlines.size === 0) this.disarm();
    return true;
  }

  /** The tab drew these nodes and has just learned they exist: cover them until the catalog shows them. */
  open(ids: Iterable<string>) {
    const deadline = this.clock.now() + BRIDGE_MS;
    let opened = false;
    for (const id of ids) {
      if (this.seen.has(id) || this.deadlines.has(id)) continue;
      this.deadlines.set(id, deadline);
      opened = true;
    }
    if (!opened) return;
    this.bridges = new Set(this.deadlines.keys());
    this.arm();
  }

  dispose() {
    this.disarm();
    this.deadlines.clear();
    this.unseen.clear();
    this.bridges = new Set();
    this.seen = new Set();
  }

  /** One timer, for the earliest deadline. */
  private arm() {
    if (this.timer !== undefined || this.deadlines.size === 0) return;
    let next = Number.POSITIVE_INFINITY;
    for (const deadline of this.deadlines.values()) next = Math.min(next, deadline);
    this.timer = this.clock.setTimeout(() => this.expire(), Math.max(0, next - this.clock.now()));
  }

  private disarm() {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Close every bridge that is due, tell the owner once, and wait for the next. */
  private expire() {
    this.timer = undefined;
    const now = this.clock.now();
    let expired = false;
    for (const [id, deadline] of this.deadlines)
      if (deadline <= now) {
        this.deadlines.delete(id);
        expired = true;
      }
    if (expired) this.bridges = new Set(this.deadlines.keys());
    this.arm();
    if (expired) this.onExpired();
  }
}
