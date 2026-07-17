/** Trace filter controls and stream projection; dev-only inline English is intentional. */
import type { EventRecord } from "@meridian/contracts/observability";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { TraceFilters as TraceFilterState } from "./trace-store";

interface TraceFiltersProps {
  entries: readonly EventRecord[];
  filters: TraceFilterState;
  onChange: (filters: TraceFilterState) => void;
}

const ALL_MESSAGE_CLASSES = "__all_message_classes__";
const BOTH_DIRECTIONS = "__both_directions__";
const fieldClass = "h-7 min-w-0 px-2 text-meta md:text-meta";
const selectClass = `${fieldClass} w-full data-[size=sm]:h-7`;

export function TraceFilters({ entries, filters, onChange }: TraceFiltersProps) {
  const messageClasses = Array.from(
    new Set(entries.flatMap((record) => record.stream?.messageClass ?? [])),
  ).sort();

  function patch(next: Partial<TraceFilterState>) {
    onChange({ ...filters, ...next });
  }

  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border p-2 lg:grid-cols-4">
      <Input
        className={fieldClass}
        aria-label="Filter by stream ID"
        placeholder="streamId"
        value={filters.streamId}
        onChange={(event) => patch({ streamId: event.target.value })}
      />
      <Select
        value={filters.messageClass || ALL_MESSAGE_CLASSES}
        onValueChange={(value) =>
          patch({ messageClass: value === ALL_MESSAGE_CLASSES ? "" : value })
        }
      >
        <SelectTrigger size="sm" className={selectClass} aria-label="Filter by message class">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ALL_MESSAGE_CLASSES} className="text-meta">
            all message classes
          </SelectItem>
          {messageClasses.map((messageClass) => (
            <SelectItem key={messageClass} value={messageClass} className="text-meta">
              {messageClass}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.direction || BOTH_DIRECTIONS}
        onValueChange={(value) =>
          patch({
            direction: value === BOTH_DIRECTIONS ? "" : (value as TraceFilterState["direction"]),
          })
        }
      >
        <SelectTrigger size="sm" className={selectClass} aria-label="Filter by direction">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={BOTH_DIRECTIONS} className="text-meta">
            both directions
          </SelectItem>
          <SelectItem value="client_to_server" className="text-meta">
            client → server
          </SelectItem>
          <SelectItem value="server_to_client" className="text-meta">
            server → client
          </SelectItem>
        </SelectContent>
      </Select>
      <Input
        className={fieldClass}
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
    <Button
      type="button"
      variant="quiet"
      size="meta"
      className={`w-full justify-between font-normal ${selected ? "bg-muted text-foreground" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="truncate font-mono">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </Button>
  );
}
