/** Best-effort diagnostics delivery. Owners supply transitions; this owns only bounded delivery. */
import {
  type ClientFailureRecord,
  clientFailureEvent,
  type FailureLog,
} from "@meridian/contracts/failures";
import type { EventRecord } from "@meridian/contracts/observability";

export function createBatchedFailureLog(ports: {
  local(event: EventRecord): void;
  send(records: readonly ClientFailureRecord[]): Promise<void>;
}) {
  const queue: ClientFailureRecord[] = [];
  const seen = new Set<string>();
  let scheduled = false;
  let pending: Promise<void> | null = null;
  let closed = false;
  async function flush(): Promise<void> {
    if (pending) {
      await pending;
      if (queue.length && !closed) await flush();
      return;
    }
    if (closed || !queue.length) return;
    pending = (async () => {
      while (queue.length && !closed) {
        const batch = queue.splice(0, 32);
        try {
          await ports.send(batch);
        } catch {
          // Ingest failure never enters the failure pipeline, and never changes a command outcome.
          ports.local({
            timestamp: new Date().toISOString(),
            level: "warn",
            source: "client",
            name: "failure.ingest_failed",
            payload: { count: batch.length },
          });
        }
      }
    })().finally(() => {
      pending = null;
    });
    await pending;
  }
  const log: FailureLog = {
    record(record) {
      const key = `${record.occurrenceId}:${record.phase}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (seen.size > 2000) seen.delete(seen.values().next().value as string);
      ports.local(clientFailureEvent(record));
      if (closed) return;
      queue.push(record);
      if (queue.length > 256) queue.shift();
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          void flush();
        });
      }
    },
  };
  return {
    ...log,
    flush,
    open() {
      closed = false;
    },
    close() {
      closed = true;
      queue.length = 0;
    },
  };
}
