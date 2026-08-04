/** Async causal scope and EventSink decorator for boundary-owned correlation. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventCorrelation, EventRecord, EventSink } from "./ports/event-sink.js";

/** Only causal identity belongs in async scope; domain/query joins stay explicit. */
export type EventCorrelationScope = Readonly<Partial<Pick<EventCorrelation, "traceId">>>;

const storage = new AsyncLocalStorage<EventCorrelationScope>();

function mergedScope(scope: EventCorrelationScope): EventCorrelationScope {
  return Object.freeze({ ...storage.getStore(), ...scope });
}

export function enterEventCorrelation(scope: EventCorrelationScope): void {
  storage.enterWith(mergedScope(scope));
}

export function runWithEventCorrelation<T>(scope: EventCorrelationScope, operation: () => T): T {
  return storage.run(mergedScope(scope), operation);
}

export function currentEventCorrelation(): EventCorrelationScope | undefined {
  return storage.getStore();
}

export class CorrelatingEventSink implements EventSink {
  constructor(private readonly delegate: EventSink) {}

  emit(event: EventRecord): void {
    const active = storage.getStore();
    if (!active || Object.keys(active).length === 0) {
      try {
        this.delegate.emit(event);
      } catch {
        // Diagnostics are evidence about an operation, never permission for it.
      }
      return;
    }

    const conflicts =
      active.traceId !== undefined &&
      event.correlation?.traceId !== undefined &&
      event.correlation.traceId !== active.traceId
        ? ["traceId"]
        : [];
    try {
      this.delegate.emit({
        ...event,
        correlation: { ...event.correlation, ...active },
      });
    } catch {
      return;
    }
    if (conflicts.length === 0 || event.name === "correlation.conflict") return;
    try {
      this.delegate.emit({
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        level: "warn",
        source: "observability",
        name: "correlation.conflict",
        sensitivity: "safe",
        correlation: active,
        payload: { fields: conflicts, conflictCount: conflicts.length },
      });
    } catch {
      // Reporting a diagnostic conflict cannot veto the original event.
    }
  }

  emitBatch(events: EventRecord[]): void {
    for (const event of events) this.emit(event);
  }

  async flush(): Promise<void> {
    try {
      await this.delegate.flush();
    } catch {
      // Flush evidence cannot veto shutdown or the operation being flushed.
    }
  }
}
