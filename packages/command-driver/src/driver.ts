/**
 * The one delivery loop for every command the server may or may not have received. It keeps
 * intent (the journal) and delivers it; what the screen shows stays with each domain. See
 * `.context/CONTEXT.md` for the rules this implements.
 */
import {
  type CommandLookupResponse,
  type CommandResolveResponse,
  WRONG_ACCOUNT_CODE,
} from "@meridian/contracts/commands";
import type {
  CommandKind,
  CommandRecord,
  DriverPorts,
  DriverSnapshot,
  HttpRequest,
  JournalChange,
  JournalState,
  Outcome,
  TransportAnswer,
  TransportRequest,
  WireOutcome,
} from "./types.js";

/** A request with no answer after this long is sent again under the same id. */
const REQUEST_DEADLINE_MS = 15_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
/** A 500 is a bug on the server: keep the command and keep trying, slowly. */
const BUG_BACKOFF_START_MS = 30_000;
const BUG_BACKOFF_CAP_MS = 300_000;
/** How long a command may go unanswered before the writer is told it is not sent yet. */
export const NOT_SENT_AFTER_MS = 10_000;
const DONE_KEPT_MS = 60_000;
const MAX_WAIT_MS = 10 * 60 * 1000;
const NEVER_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export class JournalUnavailableError extends Error {
  constructor(cause: unknown) {
    super("The command could not be saved on this device", { cause });
    this.name = "JournalUnavailableError";
  }
}

export type SubmitInput = {
  kind: string;
  /**
   * Ordering: only the earliest unsettled record of a lane is sent. A function is given the
   * journal's records inside the transaction that saves this one, for lanes that depend on them.
   */
  lanes: readonly string[] | ((records: readonly CommandRecord[]) => readonly string[]);
  body: unknown;
};

export class CommandDriver {
  /** The journal's records. */
  private records: readonly CommandRecord[] = [];
  /** What this tab shows: the journal's records with this tab's own observations. */
  private shown: readonly CommandRecord[] = [];
  private readonly observedHere = new Set<string>();
  /** Settled records this tab has not observed yet, kept after the journal drops them. */
  private readonly lingering = new Map<string, CommandRecord>();
  private snapshot: DriverSnapshot = { records: [], notSent: false, paused: false };
  private readonly listeners = new Set<() => void>();
  private readonly reacted = new Set<string>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly retryAt = new Map<string, number>();
  private readonly lookedUp = new Set<string>();
  private readonly cleanup: (() => void)[] = [];
  private reads = 0;
  private installedRead = 0;
  private release: (() => void) | null = null;
  private acquiring: AbortController | null = null;
  private delivery: AbortController | null = null;
  private suspended = false;
  private signedOut = false;
  private stopped = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private notSentTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ports: DriverPorts) {}

  /** Reads the journal, follows the other tabs and asks for the right to deliver. */
  async open(): Promise<void> {
    this.stopped = false;
    this.suspended = false;
    this.cleanup.push(this.ports.changes.subscribe(() => this.refresh()));
    // An unread journal is not an empty one: ask for the right to deliver even when the first
    // read failed. The read is tried again when the lock is held, on a nudge, and by every
    // successful write.
    try {
      await this.reload();
    } finally {
      this.acquireLock();
    }
  }

  /** Whether the journal has been read: false until the first read succeeds. */
  get hasRead(): boolean {
    return this.installedRead > 0;
  }

  stop(): void {
    this.stopped = true;
    this.suspend();
    clearTimeout(this.wakeTimer);
    clearTimeout(this.notSentTimer);
    for (const dispose of this.cleanup.splice(0)) dispose();
    this.ports.changes.close();
    this.ports.journal.close();
  }

  // --- reading ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DriverSnapshot => this.snapshot;

  /** Resolves with the record once it has settled; null if it was removed unseen. */
  whenSettled(id: string): Promise<CommandRecord | null> {
    return new Promise((resolve) => {
      const check = () => {
        const record = this.snapshot.records.find((candidate) => candidate.id === id);
        if (record && record.state === "sending") return false;
        unsubscribe();
        resolve(record ?? null);
        return true;
      };
      const unsubscribe = this.subscribe(check);
      check();
    });
  }

  // --- writing ---

  /** Resolves once the record is committed to the journal, in its place; rejects if it cannot be. */
  async submit(input: SubmitInput): Promise<CommandRecord> {
    const kind = this.ports.kinds[input.kind];
    if (!kind) throw new Error(`Unknown command kind ${input.kind}`);
    const id = crypto.randomUUID();
    let record: CommandRecord;
    try {
      record = await this.ports.journal.transact(({ records, nextSeq }) => {
        const created: CommandRecord = {
          id,
          seq: nextSeq,
          kind: input.kind,
          lanes: typeof input.lanes === "function" ? input.lanes(records) : input.lanes,
          sendId: crypto.randomUUID(),
          body: input.body,
          bodyVersion: kind.version,
          sent: false,
          state: "sending",
          observed: false,
          attempts: 0,
          since: Date.now(),
        };
        return { change: { put: [created], nextSeq: nextSeq + 1 }, result: created };
      });
    } catch (cause) {
      throw new JournalUnavailableError(cause);
    }
    await this.changed();
    return record;
  }

  /**
   * This tab's own data now includes the outcome of every matching `done` record (a read of it
   * that started after they settled has returned). Observation is per tab: its record stays in
   * this tab's snapshot, effect and all, until then, whatever another tab has seen. The journal
   * only learns that some tab has, which lets the record expire.
   */
  async observe(match: (record: CommandRecord) => boolean): Promise<void> {
    const seen = this.shown.filter(
      (record) => record.state === "done" && !this.observedHere.has(record.id) && match(record),
    );
    if (seen.length === 0) return;
    for (const record of seen) {
      this.observedHere.add(record.id);
      this.lingering.delete(record.id);
    }
    this.show();
    this.publish();
    const ids = new Set(seen.map((record) => record.id));
    await this.mutate(({ records }) => ({
      change: {
        put: records
          .filter((r) => ids.has(r.id) && r.state === "done" && !r.observed)
          .map((r) => ({ ...r, observed: true })),
      },
      result: undefined,
    }));
  }

  /**
   * The writer is done with a settled record. A refused record that holds its lanes takes with
   * it the unsent records waiting on them: they depended on it.
   */
  dismiss(id: string): Promise<void> {
    return this.mutate(({ records }) => {
      const record = records.find((candidate) => candidate.id === id);
      if (!record || record.state === "sending") return { change: {}, result: undefined };
      const waiting =
        record.state === "never" && this.ports.kinds[record.kind]?.holdsLane === true
          ? records.filter(
              (other) =>
                other.seq > record.seq &&
                other.state === "sending" &&
                !other.sent &&
                other.lanes.some((lane) => record.lanes.includes(lane)),
            )
          : [];
      return {
        change: { remove: [id, ...waiting.map((other) => other.id)] },
        result: undefined,
      };
    });
  }

  /**
   * Puts a `never` record back to sending, under a new id for the server. It keeps its place
   * while nothing later in its lanes has been sent; otherwise it goes to the end, so a lane is
   * never sent out of order.
   */
  retry(id: string): Promise<void> {
    this.reacted.delete(id);
    return this.mutate(({ records, nextSeq }) => {
      const record = records.find((candidate) => candidate.id === id);
      if (record?.state !== "never") return { change: {}, result: undefined };
      const passed = records.some(
        (other) =>
          other.seq > record.seq &&
          other.sent &&
          other.lanes.some((lane) => record.lanes.includes(lane)),
      );
      const again: CommandRecord = {
        ...record,
        seq: passed ? nextSeq : record.seq,
        state: "sending",
        sendId: crypto.randomUUID(),
        sent: false,
        request: undefined,
        outcome: undefined,
        observed: false,
        attempts: 0,
        settledAt: undefined,
      };
      return {
        change: { put: [again], nextSeq: passed ? nextSeq + 1 : undefined },
        result: undefined,
      };
    });
  }

  /** Whether a request is mid-send. */
  get delivering(): boolean {
    return this.inFlight.size > 0;
  }

  /** Something that may let a send through changed: back online, tab visible. */
  nudge(): void {
    if (this.installedRead === 0) this.refresh();
    this.retryAt.clear();
    this.publish();
    this.wake();
  }

  // --- delivery rights ---

  /** The page is going to the back-forward cache or freezing: it cannot deliver, so it lets go. */
  suspend(): void {
    this.suspended = true;
    this.acquiring?.abort();
    this.acquiring = null;
    this.delivery?.abort();
    this.delivery = null;
    this.release?.();
    this.release = null;
    this.lookedUp.clear();
    this.inFlight.clear();
  }

  /** The page is back (or the writer signed in again): ask for the right to deliver. */
  resume(): void {
    if (this.stopped) return;
    this.suspended = false;
    this.signedOut = false;
    this.publish();
    this.acquireLock();
  }

  private acquireLock(): void {
    if (this.stopped || this.suspended || this.acquiring || this.release) return;
    const acquiring = new AbortController();
    this.acquiring = acquiring;
    this.ports.lock.acquire(acquiring.signal).then(
      (release) => {
        if (this.acquiring === acquiring) this.acquiring = null;
        if (acquiring.signal.aborted || this.stopped || this.suspended) return release();
        this.release = release;
        this.delivery = new AbortController();
        // Another tab may have settled or removed records while this one waited.
        this.refresh();
      },
      () => {
        if (this.acquiring === acquiring) this.acquiring = null;
      },
    );
  }

  private fault(): void {
    this.signedOut = true;
    this.suspend();
    this.publish();
  }

  // --- the journal and what this tab shows of it ---

  private async mutate<R>(
    decide: (state: JournalState) => { change: JournalChange; result: R },
  ): Promise<R> {
    const result = await this.ports.journal.transact(decide);
    await this.changed();
    return result;
  }

  /** Tells the other tabs and reads again. The write is committed by now: a failed read is not its failure. */
  private async changed(): Promise<void> {
    this.ports.changes.post();
    await this.reload().then(undefined, (cause) =>
      this.ports.log({ id: "", kind: "journal", attempt: 0, failure: `read: ${String(cause)}` }),
    );
  }

  /** Reads again where no caller can act on a failed read: the next one is tried at the next event. */
  private refresh(): void {
    this.reload().then(undefined, (cause) =>
      this.ports.log({ id: "", kind: "journal", attempt: 0, failure: `read: ${String(cause)}` }),
    );
  }

  private async reload(): Promise<void> {
    if (this.stopped) return;
    const read = ++this.reads;
    const records = await this.ports.journal.read();
    // A later read may already be installed; an older one must not replace it.
    if (read < this.installedRead || this.stopped) return;
    this.installedRead = read;
    this.records = [...records].sort((a, b) => a.seq - b.seq);
    this.show();
    this.publish();
    for (const record of this.records) this.react(record);
    this.wake();
  }

  private show(): void {
    for (const record of this.records)
      if (record.state === "done" && !this.observedHere.has(record.id))
        this.lingering.set(record.id, { ...record, observed: false });
    const journaled = new Set(this.records.map((record) => record.id));
    // Nothing needs an id once the journal has dropped it and this tab has seen it through.
    for (const id of this.observedHere) if (!journaled.has(id)) this.observedHere.delete(id);
    for (const id of this.reacted) if (!journaled.has(id)) this.reacted.delete(id);
    const gone = [...this.lingering.values()].filter((record) => !journaled.has(record.id));
    this.shown = [
      ...this.records.map((record) =>
        record.observed === this.observedHere.has(record.id)
          ? record
          : { ...record, observed: this.observedHere.has(record.id) },
      ),
      ...gone,
    ].sort((a, b) => a.seq - b.seq);
  }

  private react(record: CommandRecord): void {
    if (record.state === "sending" || this.reacted.has(record.id)) return;
    this.reacted.add(record.id);
    try {
      this.ports.kinds[record.kind]?.onSettled?.(record);
    } catch (cause) {
      this.ports.log({
        id: record.id,
        kind: record.kind,
        attempt: record.attempts,
        failure: `onSettled: ${String(cause)}`,
      });
    }
  }

  private publish(): void {
    const waiting = this.records.filter((record) => record.state === "sending");
    const oldest = waiting.reduce(
      (at, record) => Math.min(at, record.since),
      Number.POSITIVE_INFINITY,
    );
    const late = Date.now() - oldest >= NOT_SENT_AFTER_MS;
    const notSent = waiting.length > 0 && (!this.ports.online() || late);
    clearTimeout(this.notSentTimer);
    if (waiting.length > 0 && !late)
      this.notSentTimer = setTimeout(() => this.publish(), oldest + NOT_SENT_AFTER_MS - Date.now());
    const prev = this.snapshot;
    if (prev.records === this.shown && prev.notSent === notSent && prev.paused === this.signedOut)
      return;
    this.snapshot = { records: this.shown, notSent, paused: this.signedOut };
    for (const listener of [...this.listeners]) listener();
  }

  // --- delivery ---

  private wake(): void {
    const delivery = this.delivery;
    if (!delivery || this.stopped) return;
    clearTimeout(this.wakeTimer);
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    this.prune(now);
    for (const record of this.heads()) {
      if (this.inFlight.has(record.id)) continue;
      const at = this.retryAt.get(record.id) ?? 0;
      if (at <= now && this.ports.online() && !this.ports.held() && this.ports.kinds[record.kind])
        void this.deliver(record, delivery);
      else if (at > now) next = Math.min(next, at);
    }
    for (const record of this.records) next = Math.min(next, expiry(record));
    // A timer past 2^31 ms fires at once, so a far expiry is reached in steps.
    if (next < Number.POSITIVE_INFINITY)
      this.wakeTimer = setTimeout(
        () => this.wake(),
        Math.min(MAX_WAIT_MS, Math.max(0, next - now)),
      );
  }

  /** Each sending record that is the earliest of every lane it names. */
  private heads(): CommandRecord[] {
    const first = new Map<string, string>();
    for (const record of this.records)
      if (this.holdsLanes(record))
        for (const lane of record.lanes) if (!first.has(lane)) first.set(lane, record.id);
    return this.records.filter(
      (record) =>
        record.state === "sending" && record.lanes.every((lane) => first.get(lane) === record.id),
    );
  }

  /** Whether later records of its lanes wait for it: it is sending, or refused and held. */
  private holdsLanes(record: CommandRecord): boolean {
    return (
      record.state === "sending" ||
      (record.state === "never" && this.ports.kinds[record.kind]?.holdsLane === true)
    );
  }

  private prune(now: number): void {
    if (!this.records.some((record) => expiry(record) <= now)) return;
    // Decided from what the transaction reads: another tab may have retried a record since.
    this.mutate(({ records }) => ({
      change: {
        remove: records.filter((record) => expiry(record) <= Date.now()).map((record) => record.id),
      },
      result: undefined,
    })).then(undefined, (cause) =>
      this.ports.log({ id: "", kind: "prune", attempt: 0, failure: String(cause) }),
    );
  }

  private async deliver(first: CommandRecord, delivery: AbortController): Promise<void> {
    this.inFlight.set(first.id, delivery);
    try {
      await this.attempt(first, delivery.signal);
    } catch {
      if (!delivery.signal.aborted) this.later(first, "network");
    } finally {
      if (this.inFlight.get(first.id) === delivery) this.inFlight.delete(first.id);
      if (!delivery.signal.aborted) this.wake();
    }
  }

  private async attempt(record: CommandRecord, signal: AbortSignal): Promise<void> {
    const kind = this.ports.kinds[record.kind];
    // After a reload or a lost lock the server may already have it: ask before sending it again.
    if (record.sent && !this.lookedUp.has(record.id)) {
      this.lookedUp.add(record.id);
      const found = await this.call(
        { method: "GET", path: this.ports.routes.lookup(record.sendId) },
        signal,
      );
      if (this.isAccountFault(found)) return this.fault();
      const stored = found.status === 200 ? (found.body as CommandLookupResponse) : null;
      if (stored?.status === "stored") return this.settle(record, outcomeOf(stored.outcome));
    }
    await kind.ready?.(record, signal);
    if (signal.aborted) return;
    const attempt = await this.markAttempt(record, kind);
    if (!attempt?.request) return;
    const { method, path, body } = attempt.request;
    const answer = await this.call(
      { method, path, body: { ...body, commandId: attempt.sendId } },
      signal,
    );
    await this.answered(attempt, answer, signal);
  }

  private async answered(
    record: CommandRecord,
    answer: TransportAnswer,
    signal: AbortSignal,
  ): Promise<void> {
    const { status } = answer;
    if (status >= 200 && status < 300)
      return this.settle(record, { status: "done", result: answer.body });
    if (this.isAccountFault(answer)) return this.fault();
    if (status === 408 || status === 429 || status >= 500)
      return this.later(record, `http_${status}`, status === 500);
    // Any other refusal says nothing about whether an earlier attempt landed: the server's
    // stored outcome does, and where there is none it stores a `never`.
    const resolved = await this.call(
      {
        method: "POST",
        path: this.ports.routes.resolve(record.sendId),
        body: { kind: record.kind },
      },
      signal,
    );
    if (this.isAccountFault(resolved)) return this.fault();
    const outcome = (resolved.body as Partial<CommandResolveResponse> | null)?.outcome;
    if (resolved.status === 200 && outcome)
      return this.settle(record, outcomeOf(outcome, answer.code));
    if (resolved.status === 400) this.ports.unreadable();
    this.later(record, `resolve_http_${resolved.status}`, true);
  }

  private isAccountFault({ status, code }: TransportAnswer): boolean {
    return status === 401 || (status === 409 && code === WRONG_ACCOUNT_CODE);
  }

  private async call(request: TransportRequest, signal: AbortSignal): Promise<TransportAnswer> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), REQUEST_DEADLINE_MS);
    try {
      return await this.ports.transport(request, AbortSignal.any([signal, deadline.signal]));
    } finally {
      clearTimeout(timer);
    }
  }

  private later(record: CommandRecord, failure: string, bug = false): void {
    const n = Math.max(1, record.attempts);
    const [start, cap] = bug
      ? [BUG_BACKOFF_START_MS, BUG_BACKOFF_CAP_MS]
      : [BACKOFF_START_MS, BACKOFF_CAP_MS];
    this.retryAt.set(record.id, Date.now() + Math.min(cap, start * 2 ** (n - 1)));
    if (bug)
      this.ports.log({ id: record.id, kind: record.kind, attempt: record.attempts, failure });
  }

  /** Saves `sent` (and the request, on the first send) before the request leaves. */
  private markAttempt(record: CommandRecord, kind: CommandKind): Promise<CommandRecord | null> {
    return this.mutate(({ records }) => {
      const stored = records.find((candidate) => candidate.id === record.id);
      if (stored?.state !== "sending" || stored.sendId !== record.sendId)
        return { change: {}, result: null };
      // Another tab may have put an earlier record of a lane back since this one was chosen.
      if (!this.headsItsLanes(records, stored)) return { change: {}, result: null };
      if (stored.sent) {
        const again = { ...stored, attempts: stored.attempts + 1 };
        return { change: { put: [again] }, result: again };
      }
      try {
        const body =
          stored.bodyVersion === kind.version
            ? stored.body
            : kind.migrate(stored.body, stored.bodyVersion);
        const request: HttpRequest = kind.request({ id: stored.id, body });
        const sent = {
          ...stored,
          body,
          bodyVersion: kind.version,
          request,
          sent: true,
          attempts: 1,
        };
        return { change: { put: [sent] }, result: sent };
      } catch {
        // A body this build cannot read, never sent: nothing can ever happen to it.
        const never = settled(stored, { status: "never" });
        return { change: { put: [never] }, result: null };
      }
    });
  }

  /** Whether no earlier record that holds its lanes shares a lane with this one. */
  private headsItsLanes(records: readonly CommandRecord[], record: CommandRecord): boolean {
    return !records.some(
      (other) =>
        this.holdsLanes(other) &&
        other.seq < record.seq &&
        other.lanes.some((lane) => record.lanes.includes(lane)),
    );
  }

  private async settle(record: CommandRecord, outcome: Outcome): Promise<void> {
    await this.mutate(({ records }) => {
      const stored = records.find((candidate) => candidate.id === record.id);
      if (stored?.state !== "sending" || stored.sendId !== record.sendId)
        return { change: {}, result: undefined };
      return { change: { put: [settled(stored, outcome)] }, result: undefined };
    });
    this.retryAt.delete(record.id);
  }
}

/** When a settled record may go: observed `done` after a minute, a `never` after thirty days. */
function expiry(record: CommandRecord): number {
  if (record.settledAt === undefined) return Number.POSITIVE_INFINITY;
  if (record.state === "done" && record.observed) return record.settledAt + DONE_KEPT_MS;
  if (record.state === "never") return record.settledAt + NEVER_KEPT_MS;
  return Number.POSITIVE_INFINITY;
}

function settled(record: CommandRecord, outcome: Outcome): CommandRecord {
  return { ...record, sent: true, state: outcome.status, outcome, settledAt: Date.now() };
}

/** Until Work refusals are settled outcomes, the server still stores `refused`: it never took effect. */
function outcomeOf(wire: WireOutcome, code?: string | null): Outcome {
  if (wire.status === "done") return { status: "done", result: wire.result };
  return {
    status: "never",
    result: wire.status === "refused" ? wire.result : undefined,
    ...(code ? { code } : {}),
  };
}
