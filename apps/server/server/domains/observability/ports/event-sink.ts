import type { EventRecord } from "@meridian/contracts/observability";

export type {
  EventCorrelation,
  EventLevel,
  EventRecord,
  EventSensitivity,
  TraceStreamRef,
} from "@meridian/contracts/observability";

export interface EventSink {
  emit(event: EventRecord): void;
  emitBatch(events: EventRecord[]): void;
  flush(): Promise<void>;
}
