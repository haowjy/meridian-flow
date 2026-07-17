/** Live EventRecord table projection; dev-only inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";
import { useEffect, useRef } from "react";

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return timestamp;
  return date.toISOString().slice(11, 23);
}

function truncate(value: string, length = 48): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function traceRowKey(record: EventRecord, index: number): string {
  return record.stream
    ? `${record.stream.streamId}:${record.stream.observedAt}:${record.stream.observerSeq}`
    : (record.eventId ?? `${record.timestamp}:${index}`);
}

export function TraceTable({
  entries,
  following,
  selected,
  onSelect,
}: {
  entries: readonly EventRecord[];
  following: boolean;
  selected: EventRecord | null;
  onSelect: (record: EventRecord) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!following) return;
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [entries, following]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <table className="w-full border-collapse text-left font-mono text-meta">
        <thead className="sticky top-0 bg-background text-muted-foreground">
          <tr className="border-b border-border">
            <th className="px-2 py-1.5 font-medium">time</th>
            <th className="px-2 py-1.5 font-medium">stream</th>
            <th className="px-2 py-1.5 font-medium">dir</th>
            <th className="px-2 py-1.5 font-medium">class</th>
            <th className="px-2 py-1.5 text-right font-medium">bytes</th>
            <th className="px-2 py-1.5 font-medium">Yjs spans</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((record, index) => {
            const stream = record.stream;
            const active = record === selected;
            return (
              <tr
                key={traceRowKey(record, index)}
                className={`cursor-pointer border-b border-border-subtle ${active ? "bg-muted" : "hover:bg-muted"}`}
                onClick={() => onSelect(record)}
                aria-selected={active}
              >
                <td className="whitespace-nowrap px-2 py-1.5">{formatTime(record.timestamp)}</td>
                <td className="max-w-48 truncate px-2 py-1.5">{stream?.streamId ?? "—"}</td>
                <td className="px-2 py-1.5" aria-label={stream?.direction ?? "no direction"}>
                  {stream?.direction === "client_to_server"
                    ? "→"
                    : stream?.direction === "server_to_client"
                      ? "←"
                      : "—"}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {stream?.messageClass ?? record.name}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{stream?.bytes ?? "—"}</td>
                <td className="max-w-64 truncate px-2 py-1.5" title={record.correlation?.yjsSpans}>
                  {record.correlation?.yjsSpans ? truncate(record.correlation.yjsSpans) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {entries.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">No captured events match.</p>
      ) : null}
    </div>
  );
}
