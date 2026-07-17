/** Trace filter controls and stream projection; dev-only inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";

import type { TraceFilters as TraceFilterState } from "./trace-store";

interface TraceFiltersProps {
  entries: readonly EventRecord[];
  filters: TraceFilterState;
  onChange: (filters: TraceFilterState) => void;
}

const inputClass =
  "focus-ring h-7 min-w-0 rounded border border-border bg-background px-2 text-meta text-foreground placeholder:text-muted-foreground";

export function TraceFilters({ entries, filters, onChange }: TraceFiltersProps) {
  const messageClasses = Array.from(
    new Set(entries.flatMap((record) => record.stream?.messageClass ?? [])),
  ).sort();

  function patch(next: Partial<TraceFilterState>) {
    onChange({ ...filters, ...next });
  }

  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border p-2 lg:grid-cols-4">
      <input
        className={inputClass}
        aria-label="Filter by stream ID"
        placeholder="streamId"
        value={filters.streamId}
        onChange={(event) => patch({ streamId: event.target.value })}
      />
      <select
        className={inputClass}
        aria-label="Filter by message class"
        value={filters.messageClass}
        onChange={(event) => patch({ messageClass: event.target.value })}
      >
        <option value="">all message classes</option>
        {messageClasses.map((messageClass) => (
          <option key={messageClass} value={messageClass}>
            {messageClass}
          </option>
        ))}
      </select>
      <select
        className={inputClass}
        aria-label="Filter by direction"
        value={filters.direction}
        onChange={(event) =>
          patch({ direction: event.target.value as TraceFilterState["direction"] })
        }
      >
        <option value="">both directions</option>
        <option value="client_to_server">client → server</option>
        <option value="server_to_client">server → client</option>
      </select>
      <input
        className={inputClass}
        aria-label="Filter by document, branch, or stream correlation"
        placeholder="document / branch / stream"
        value={filters.correlation}
        onChange={(event) => patch({ correlation: event.target.value })}
      />
    </div>
  );
}

interface StreamListProps {
  entries: readonly EventRecord[];
  selectedStreamId: string;
  onSelect: (streamId: string) => void;
}

export function StreamList({ entries, selectedStreamId, onSelect }: StreamListProps) {
  const counts = new Map<string, number>();
  for (const record of entries) {
    if (record.stream) {
      counts.set(record.stream.streamId, (counts.get(record.stream.streamId) ?? 0) + 1);
    }
  }

  return (
    <nav className="flex min-h-0 flex-col border-b border-border lg:w-56 lg:shrink-0 lg:border-r lg:border-b-0">
      <div className="border-b border-border px-3 py-2 text-xs font-medium">Streams</div>
      <div className="max-h-32 overflow-auto p-1 lg:max-h-none lg:flex-1">
        <StreamButton
          label="All streams"
          count={entries.length}
          selected={!selectedStreamId}
          onClick={() => onSelect("")}
        />
        {Array.from(counts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([streamId, count]) => (
            <StreamButton
              key={streamId}
              label={streamId}
              count={count}
              selected={selectedStreamId === streamId}
              onClick={() => onSelect(streamId)}
            />
          ))}
      </div>
    </nav>
  );
}

function StreamButton({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`focus-ring flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-meta ${selected ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="truncate font-mono">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </button>
  );
}
