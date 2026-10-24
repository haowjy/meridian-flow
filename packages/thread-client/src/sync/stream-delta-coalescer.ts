/**
 * stream-delta-coalescer — folds a burst of append-only text/reasoning deltas
 * into one store event per animation frame.
 *
 * Server-side delta batches reduce frames during bursts, but paced streams and
 * replay can still deliver faster than the screen paints. Merging runs that
 * share the same message id caps store updates at one per frame without
 * changing event order: any non-delta event (or a delta for a different
 * message) flushes the pending run first.
 *
 * Only append-only deltas are merged. Everything else passes through untouched,
 * so lifecycle/ordering semantics are unchanged.
 */
import { type AGUIEvent, EventType } from "@meridian/contracts/protocol";

type DeltaEvent = AGUIEvent & { messageId?: string; delta?: string };

const MERGEABLE_TYPES = new Set<EventType>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.THINKING_TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CHUNK,
]);

export type ScheduleFlush = (flush: () => void) => () => void;

/** Coalesce on the frame boundary; fall back to a macrotask where rAF is absent. */
export const frameScheduler: ScheduleFlush = (flush) => {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(flush, 16);
  return () => clearTimeout(handle);
};

function mergeKey(event: AGUIEvent): string | null {
  if (!MERGEABLE_TYPES.has(event.type)) return null;
  const { messageId, delta } = event as DeltaEvent;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  if (typeof delta !== "string" || delta.length === 0) return null;
  return `${event.type}:${messageId}`;
}

export class StreamDeltaCoalescer {
  private key: string | null = null;
  private event: AGUIEvent | null = null;
  private delta = "";
  /** The highest seq among the pending run's events. */
  private seq: string | undefined;
  private cancelScheduled: (() => void) | null = null;

  constructor(
    private readonly apply: (event: AGUIEvent, seq?: string) => void,
    private readonly schedule: ScheduleFlush = frameScheduler,
  ) {}

  /** `seq` is the frame's: a flush hands `apply` the highest one its run carried. */
  push(event: AGUIEvent, seq?: string): void {
    const key = mergeKey(event);
    if (key === null) {
      this.flush();
      this.apply(event, seq);
      return;
    }
    if (this.key !== null && this.key !== key) this.flush();
    this.key = key;
    this.event = event;
    this.seq = seq;
    this.delta += (event as DeltaEvent).delta;
    this.cancelScheduled ??= this.schedule(() => this.flush());
  }

  flush(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    const event = this.event;
    const delta = this.delta;
    const seq = this.seq;
    this.key = null;
    this.seq = undefined;
    this.event = null;
    this.delta = "";
    if (event) this.apply({ ...event, delta } as AGUIEvent, seq);
  }
}
