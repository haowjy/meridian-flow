/**
 * One draft's FIFO of frozen Apply clicks. Two independent duties per click:
 * - release: the click leaves the FIFO (its optimistic contribution ends) exactly once, on the
 *   room's record or on a terminal answer. Unknown delivery never releases the head.
 * - completion: the caller's promise resolves from the full answer or, when the record released
 *   a click whose answer is missing or lost, from the stored result under the same command id.
 *   Arrival order of answer, record and failure never decides which.
 */
import type {
  ApplyClick,
  ApplyClickAnswer,
  ApplyClickObservation,
  ApplyClickResult,
} from "@meridian/contracts/branches";
import type { Node as PMNode } from "@tiptap/pm/model";

export type FrozenApply = {
  body: ApplyClick;
  optimistic: readonly PMNode[];
  patched: readonly PMNode[];
  acknowledged: Promise<void>;
};
/**
 * The room recorded the click, but neither its answer nor its stored result could be read after
 * every retry. It landed; what only the result carries (`restored`) is unknown.
 */
export type ApplyClickLanded = { status: "landed"; commandId: string };
export type ApplyClickOutcome = ApplyClickResult | ApplyClickLanded | { status: "cancelled" };
type Click = FrozenApply & {
  sent: boolean;
  attempts: number;
  stalled: boolean;
  answer?: ApplyClickResult;
  inFlight?: boolean;
  reading?: boolean;
  finish(result: ApplyClickOutcome): void;
};
export const APPLY_FEEDBACK_MS = 500;
const RETRY_DELAYS = [1000, 2000, 4000];

export class ApplyClickQueue {
  readonly clicks: Click[] = [];
  private recorded = new Set<string>();
  private closed = false;
  private request: Click | null = null;
  /** Released by the record, not yet completed: awaiting the in-flight answer or reading the stored result. */
  private readonly resolving = new Set<Click>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private feedbackTimer?: ReturnType<typeof setTimeout>;
  applying = false;

  constructor(
    private readonly port: {
      send(body: ApplyClick): Promise<ApplyClickAnswer>;
      lookup(body: ApplyClick): Promise<ApplyClickObservation>;
      changed(): void;
      refused(answer: Exclude<ApplyClickResult, { status: "applied" }>): void;
    },
  ) {}

  enqueue(frozen: FrozenApply): Promise<ApplyClickOutcome> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = new Promise<ApplyClickOutcome>((finish) => {
      const click: Click = { ...frozen, sent: false, attempts: 0, stalled: false, finish };
      this.clicks.push(click);
      void frozen.acknowledged.then(
        () => {
          if (this.clicks.includes(click)) {
            click.acknowledged = Promise.resolve();
            if (this.clicks[0] === click) void this.dispatch(click);
          }
        },
        () => this.refuseUnsent(click),
      );
    });
    if (!this.feedbackTimer)
      this.feedbackTimer = setTimeout(() => {
        this.applying = this.clicks.length > 0;
        this.port.changed();
      }, APPLY_FEEDBACK_MS);
    this.port.changed();
    return result;
  }

  /** The record alone proves landing. It and the base arrive in the same Yjs transaction. */
  observe(commandIds: Iterable<string>): void {
    this.recorded = new Set(commandIds);
    const head = this.clicks[0];
    if (head && this.recorded.has(head.body.commandId)) {
      this.release(head);
      this.complete(head);
    } else this.port.changed();
  }

  retry(): void {
    const head = this.clicks[0];
    if (!head?.stalled) return;
    head.stalled = false;
    head.attempts = 0;
    this.port.changed();
    void this.dispatch(head);
  }

  /** A retired session cannot acknowledge its unsent cuts; sent ids keep their settlement. */
  refuseUnsent(only?: Click): void {
    for (const click of [...this.clicks]) {
      if (click.sent || (only && click !== only)) continue;
      const answer = {
        status: "refused",
        commandId: click.body.commandId,
        reason: "unsynced",
      } as const;
      this.clicks.splice(this.clicks.indexOf(click), 1);
      this.port.refused(answer);
      click.finish(answer);
    }
    this.clearFeedbackIfIdle();
    this.port.changed();
  }

  /** Closed rooms cannot deliver records. Only a durable answer/lookup can settle a sent head. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    const head = this.clicks[0];
    const cancelled = this.clicks.splice(head?.sent ? 1 : 0);
    for (const click of cancelled) click.finish({ status: "cancelled" });
    this.clearFeedbackIfIdle();
    if (head?.sent) {
      if (head.answer?.status === "applied") this.settle(head, head.answer);
      else if (!this.request) void this.lookupClosed(head);
    }
    this.port.changed();
  }

  destroy(): void {
    clearTimeout(this.retryTimer);
    clearTimeout(this.feedbackTimer);
    for (const click of this.clicks.splice(0)) click.finish({ status: "cancelled" });
    // Recorded clicks landed; stop reading their results and say only that.
    for (const click of this.resolving)
      click.finish({ status: "landed", commandId: click.body.commandId });
    this.resolving.clear();
  }

  private async dispatch(click: Click): Promise<void> {
    if (this.request || this.clicks[0] !== click || click.stalled) return;
    try {
      await click.acknowledged;
    } catch {
      this.refuseUnsent(click);
      return;
    }
    if (this.request || this.clicks[0] !== click) return;
    this.request = click;
    click.sent = true;
    click.inFlight = true;
    let answer: ApplyClickObservation | undefined;
    try {
      answer = await (this.closed ? this.port.lookup(click.body) : this.port.send(click.body));
    } catch {
      // No answer is not a refusal. The immutable command remains the only head.
    }
    click.inFlight = false;
    if (this.request === click) this.request = null;
    if (answer?.commandId !== click.body.commandId) answer = undefined;
    if (answer?.status === "applied") click.answer = answer;
    if (this.clicks[0] !== click) {
      // The record released it while the request was in flight (or the queue was destroyed).
      if (this.resolving.has(click)) this.complete(click);
      const next = this.clicks[0];
      if (next) void this.dispatch(next);
      return;
    }
    if (answer?.status === "applied") {
      if (!click.body.snapshot || this.closed || this.recorded.has(click.body.commandId))
        this.settle(click, answer);
      // Otherwise keep the optimistic contribution until the room's record arrives.
      return;
    }
    if (
      answer?.status === "closed" ||
      answer?.status === "refused" ||
      answer?.status === "needs_restore"
    ) {
      this.port.refused(answer);
      this.settle(click, answer);
      return;
    }
    if (this.closed && answer?.status === "none") {
      this.settle(click, { status: "cancelled" });
      return;
    }
    if (this.closed && !answer) {
      // An in-flight send may have been answered by the close. Observe it before counting a retry.
      void this.lookupClosed(click);
      return;
    }
    this.scheduleRetry(click);
  }

  private async lookupClosed(click: Click): Promise<void> {
    try {
      const result = await this.port.lookup(click.body);
      if (this.clicks[0] !== click || result.commandId !== click.body.commandId) return;
      if (
        result.status === "applied" ||
        result.status === "closed" ||
        result.status === "refused" ||
        result.status === "needs_restore"
      ) {
        if (result.status !== "applied") this.port.refused(result);
        this.settle(click, result);
        return;
      }
      if (result.status === "none") {
        this.settle(click, { status: "cancelled" });
        return;
      }
    } catch {
      /* Remains unknown. */
    }
    this.scheduleRetry(click);
  }

  /**
   * The sole completion path for a click the record released. Its full answer completes it;
   * while the request is in flight, `dispatch` calls back here when it ends; otherwise the
   * stored result is read under the same command id, never resent. Exhausted reads complete
   * as `landed`.
   */
  private complete(click: Click): void {
    if (click.answer) {
      this.resolving.delete(click);
      click.finish(click.answer);
      return;
    }
    this.resolving.add(click);
    if (!click.inFlight && !click.reading) void this.readResult(click);
  }

  private async readResult(click: Click): Promise<void> {
    click.reading = true;
    for (const delay of [0, ...RETRY_DELAYS]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!this.resolving.has(click)) return;
      try {
        const result = await this.port.lookup(click.body);
        if (result.status === "applied" && result.commandId === click.body.commandId) {
          if (this.resolving.delete(click)) click.finish(result);
          return;
        }
      } catch {
        /* Still unknown; the record already proved landing. */
      }
    }
    if (this.resolving.delete(click))
      click.finish({ status: "landed", commandId: click.body.commandId });
  }

  private scheduleRetry(click: Click): void {
    const delay = RETRY_DELAYS[click.attempts++];
    if (delay === undefined) click.stalled = true;
    else this.retryTimer = setTimeout(() => void this.dispatch(click), delay);
    this.port.changed();
  }

  private clearFeedbackIfIdle() {
    if (this.clicks.length) return;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.applying = false;
  }

  /** Ends the click's optimistic contribution and moves the FIFO on. Exactly once per click. */
  private release(click: Click): boolean {
    if (this.clicks[0] !== click) return false;
    clearTimeout(this.retryTimer);
    this.clicks.shift();
    // An in-flight request no longer blocks the next click; its answer still completes this one.
    if (this.request === click) this.request = null;
    this.clearFeedbackIfIdle();
    this.port.changed();
    const next = this.clicks[0];
    if (next && !this.request) void this.dispatch(next);
    return true;
  }

  private settle(click: Click, result: ApplyClickOutcome): void {
    if (this.release(click)) click.finish(result);
  }
}
