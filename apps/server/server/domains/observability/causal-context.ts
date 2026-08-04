/** Async causal scope and EventSink decorator for boundary-owned correlation. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventCorrelation, EventRecord, EventSink } from "./ports/event-sink.js";

export type EventCorrelationScope = Readonly<Partial<EventCorrelation>>;

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
      this.delegate.emit(event);
      return;
    }

    const conflicts = Object.keys(active)
      .filter((key) => {
        const correlationKey = key as keyof EventCorrelation;
        const supplied = event.correlation?.[correlationKey];
        return supplied !== undefined && supplied !== active[correlationKey];
      })
      .slice(0, 16);
    this.delegate.emit({
      ...event,
      correlation: { ...event.correlation, ...active },
    });
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

  flush(): Promise<void> {
    return this.delegate.flush();
  }
}
