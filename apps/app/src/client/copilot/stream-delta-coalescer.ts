/**
 * stream-delta-coalescer — folds a burst of append-only text/reasoning deltas
 * into one store event per animation frame.
 *
 * The server emits one `TEXT_MESSAGE_CONTENT` / `REASONING_MESSAGE_CONTENT` per
 * streaming chunk. Applying each one directly means one Zustand update, one
 * React render of the whole chat surface, and one markdown reparse per chunk.
 * Merging runs that share the same message id cuts that to at most one update
 * per frame, without changing event order: any non-delta event (or a delta for
 * a different message) flushes the pending run first.
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

type ScheduleFlush = (flush: () => void) => () => void;

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
  private cancelScheduled: (() => void) | null = null;

  constructor(
    private readonly apply: (event: AGUIEvent) => void,
    private readonly schedule: ScheduleFlush = frameScheduler,
  ) {}

  push(event: AGUIEvent): void {
    const key = mergeKey(event);
    if (key === null) {
      this.flush();
      this.apply(event);
      return;
    }
    if (this.key !== null && this.key !== key) this.flush();
    this.key = key;
    this.event = event;
    this.delta += (event as DeltaEvent).delta;
    this.cancelScheduled ??= this.schedule(() => this.flush());
  }

  flush(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    const event = this.event;
    const delta = this.delta;
    this.key = null;
    this.event = null;
    this.delta = "";
    if (event) this.apply({ ...event, delta } as AGUIEvent);
  }
}
