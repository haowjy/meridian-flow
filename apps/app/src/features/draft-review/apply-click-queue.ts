/** One draft's FIFO of frozen Apply clicks. Unknown delivery never releases the head. */
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
type Click = FrozenApply & {
  sent: boolean;
  attempts: number;
  stalled: boolean;
  answer?: ApplyClickResult;
  finish(result: ApplyClickResult | { status: "cancelled" }): void;
};
export const APPLY_FEEDBACK_MS = 500;
const RETRY_DELAYS = [1000, 2000, 4000];

export class ApplyClickQueue {
  readonly clicks: Click[] = [];
  private recorded = new Set<string>();
  private closed = false;
  private request: Click | null = null;
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

  enqueue(frozen: FrozenApply): Promise<ApplyClickResult | { status: "cancelled" }> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = new Promise<ApplyClickResult | { status: "cancelled" }>((finish) => {
      const click: Click = { ...frozen, sent: false, attempts: 0, stalled: false, finish };
      this.clicks.push(click);
      void frozen.acknowledged.then(() => {
        if (this.clicks.includes(click)) {
          click.acknowledged = Promise.resolve();
          if (this.clicks[0] === click) void this.dispatch(click);
        }
      });
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
    if (head && this.recorded.has(head.body.commandId))
      this.settle(head, { status: "applied", commandId: head.body.commandId });
    else this.port.changed();
  }

  retry(): void {
    const head = this.clicks[0];
    if (!head?.stalled) return;
    head.stalled = false;
    head.attempts = 0;
    this.port.changed();
    void this.dispatch(head);
  }

  /** Closed rooms cannot deliver records. Only a durable answer/lookup can settle a sent head. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    const head = this.clicks[0];
    const cancelled = this.clicks.splice(head?.sent ? 1 : 0);
    for (const click of cancelled) click.finish({ status: "cancelled" });
    if (!this.clicks.length) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = undefined;
      this.applying = false;
    }
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
  }

  private async dispatch(click: Click): Promise<void> {
    if (this.request || this.clicks[0] !== click || click.stalled) return;
    await click.acknowledged;
    if (this.request || this.clicks[0] !== click) return;
    this.request = click;
    click.sent = true;
    let answer: ApplyClickObservation | undefined;
    try {
      answer = await (this.closed ? this.port.lookup(click.body) : this.port.send(click.body));
    } catch {
      // No answer is not a refusal. The immutable command remains the only head.
    }
    if (this.request === click) this.request = null;
    if (this.clicks[0] !== click) {
      const next = this.clicks[0];
      if (next) void this.dispatch(next);
      return;
    }
    if (answer?.commandId !== click.body.commandId) answer = undefined;
    if (answer?.status === "applied") {
      click.answer = answer;
      if (!click.body.snapshot || this.closed || this.recorded.has(click.body.commandId))
        this.settle(click, answer);
      // Otherwise keep the optimistic contribution until the room's record arrives.
      return;
    }
    if (answer?.status === "closed" || answer?.status === "refused") {
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
        result.status === "refused"
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

  private scheduleRetry(click: Click): void {
    const delay = RETRY_DELAYS[click.attempts++];
    if (delay === undefined) click.stalled = true;
    else this.retryTimer = setTimeout(() => void this.dispatch(click), delay);
    this.port.changed();
  }

  private settle(click: Click, result: ApplyClickResult | { status: "cancelled" }): void {
    if (this.clicks[0] !== click) return;
    clearTimeout(this.retryTimer);
    this.clicks.shift();
    if (this.request === click) this.request = null;
    click.finish(result);
    if (!this.clicks.length) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = undefined;
      this.applying = false;
    }
    this.port.changed();
    const next = this.clicks[0];
    if (next && !this.request) void this.dispatch(next);
  }
}
