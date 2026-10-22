/**
 * One review item's FIFO of frozen Apply clicks: text, tree, or text+tree. A text click names
 * its draft (`body.draftId`); that draft's room records it, and closing that draft closes only
 * its clicks, so a later draft under the same item key never inherits one. A tree-only click
 * has no room: its applied answer settles it. Two independent duties per click:
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
/** An answer that ends a click unapplied: nothing changed, and resending can't change that. */
function isFinalRefusal(
  answer: ApplyClickObservation,
): answer is Exclude<ApplyClickResult, { status: "applied" }> {
  return (
    answer.status === "closed" ||
    answer.status === "refused" ||
    answer.status === "needs_restore" ||
    answer.status === "changed"
  );
}

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
  /** Its draft closed (or the queue did): no record can arrive, only a durable answer settles it. */
  closed: boolean;
  answer?: ApplyClickResult;
  inFlight?: boolean;
  reading?: boolean;
  finish(result: ApplyClickOutcome): void;
};
export const APPLY_FEEDBACK_MS = 500;
const RETRY_DELAYS = [1000, 2000, 4000];

export class ApplyClickQueue {
  readonly clicks: Click[] = [];
  /** Each draft room's recorded command ids. */
  private readonly recorded = new Map<string, Set<string>>();
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
    },
  ) {}

  enqueue(frozen: FrozenApply): Promise<ApplyClickOutcome> {
    if (this.closed) return Promise.resolve({ status: "cancelled" });
    const result = new Promise<ApplyClickOutcome>((finish) => {
      const click: Click = {
        ...frozen,
        sent: false,
        attempts: 0,
        stalled: false,
        closed: false,
        finish,
      };
      this.clicks.push(click);
      void frozen.acknowledged.then(
        () => {
          if (this.clicks.includes(click)) {
            click.acknowledged = Promise.resolve();
            if (this.clicks[0] === click) void this.dispatch(click);
          }
        },
        () => this.refuse(click),
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
  observe(draftId: string, commandIds: Iterable<string>): void {
    this.recorded.set(draftId, new Set(commandIds));
    const head = this.clicks[0];
    if (head && this.isRecorded(head)) {
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

  private isRecorded(click: Click): boolean {
    const { draftId, commandId } = click.body;
    return draftId !== undefined && (this.recorded.get(draftId)?.has(commandId) ?? false);
  }

  /** A retired session cannot acknowledge its draft's unsent cuts; sent ids keep their settlement. */
  refuseUnsent(draftId: string): void {
    for (const click of this.clicks.filter((click) => click.body.draftId === draftId))
      this.refuse(click);
  }

  private refuse(click: Click): void {
    const index = this.clicks.indexOf(click);
    if (click.sent || index < 0) return;
    this.clicks.splice(index, 1);
    click.finish({ status: "refused", commandId: click.body.commandId, reason: "unsynced" });
    this.moveOn();
  }

  /**
   * A closed room cannot deliver records: its draft's unsent clicks are cancelled, and only a
   * durable answer/lookup can settle its sent head. Other drafts' and tree clicks go on.
   * Without a draft, the whole queue closes (the account is ending).
   */
  close(draftId?: string): void {
    if (this.closed) return;
    if (draftId === undefined) {
      this.closed = true;
      clearTimeout(this.retryTimer);
    }
    const closing = this.clicks.filter(
      (click) => !click.closed && (draftId === undefined || click.body.draftId === draftId),
    );
    const head = this.clicks[0];
    for (const click of closing) {
      click.closed = true;
      if (click === head && click.sent) continue;
      this.clicks.splice(this.clicks.indexOf(click), 1);
      click.finish({ status: "cancelled" });
    }
    if (head?.sent && closing.includes(head)) {
      if (head.answer?.status === "applied") this.settle(head, head.answer);
      else if (!this.request) void this.lookupClosed(head);
    }
    this.moveOn();
  }

  /** After clicks left out of turn: the next head is sent unless one is already in flight. */
  private moveOn(): void {
    this.clearFeedbackIfIdle();
    this.port.changed();
    const next = this.clicks[0];
    if (next && !this.request && !next.sent && !this.closed) void this.dispatch(next);
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
      this.refuse(click);
      return;
    }
    if (this.request || this.clicks[0] !== click) return;
    this.request = click;
    click.sent = true;
    click.inFlight = true;
    let answer: ApplyClickObservation | undefined;
    try {
      answer = await (click.closed ? this.port.lookup(click.body) : this.port.send(click.body));
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
      if (!click.body.draftId || click.closed || this.isRecorded(click)) this.settle(click, answer);
      // Otherwise keep the optimistic contribution until the room's record arrives.
      return;
    }
    if (answer && isFinalRefusal(answer)) {
      this.settle(click, answer);
      return;
    }
    if (click.closed && answer?.status === "none") {
      this.settle(click, { status: "cancelled" });
      return;
    }
    if (click.closed && !answer) {
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
      if (result.status === "applied" || isFinalRefusal(result)) {
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
