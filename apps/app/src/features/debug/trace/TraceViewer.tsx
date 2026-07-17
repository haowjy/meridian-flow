/**
 * Full-height drawer for inspecting captured EventRecords.
 * i18n exception: this build-gated debug feature uses inline English by design.
 */
import type { EventRecord } from "@meridian/contracts/observability";
import { memo, useMemo, useState } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import { JsonTree } from "../JsonTree";
import { TraceExport } from "./TraceExport";
import { StreamList, TraceFilters } from "./TraceFilters";
import { TraceTable } from "./TraceTable";
import {
  clearTraceEvents,
  filterTraceEntries,
  getTraceSnapshot,
  type TraceFilters as TraceFilterState,
} from "./trace-store";
import { useTraceStore } from "./use-trace-store";

const EMPTY_FILTERS: TraceFilterState = {
  streamId: "",
  messageClass: "",
  direction: "",
  correlation: "",
};

export function TraceViewer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {open ? <TraceViewerContent /> : null}
    </Sheet>
  );
}

function TraceViewerContent() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [frozenEntries, setFrozenEntries] = useState<readonly EventRecord[] | null>(null);
  const [selected, setSelected] = useState<EventRecord | null>(null);
  const paused = frozenEntries !== null;

  function togglePaused() {
    setFrozenEntries((current) => (current === null ? getTraceSnapshot().entries : null));
  }

  function clear() {
    clearTraceEvents();
    setFrozenEntries(null);
    setSelected(null);
  }

  return (
    <SheetContent side="right" className="w-11/12 gap-0 p-0 sm:max-w-5xl" aria-label="Trace viewer">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3 pr-12">
        <div>
          <SheetTitle>Streams</SheetTitle>
          <SheetDescription>Live client observability events</SheetDescription>
        </div>
        <TraceCounters paused={paused} />
        <button
          type="button"
          className="focus-ring rounded border border-border px-2 py-1 text-meta hover:bg-muted"
          onClick={togglePaused}
        >
          {paused ? "Resume live tail" : "Pause / freeze"}
        </button>
        <button
          type="button"
          className="focus-ring rounded border border-border px-2 py-1 text-meta hover:bg-muted"
          onClick={clear}
        >
          Clear
        </button>
      </header>

      {frozenEntries === null ? (
        <LiveTraceBody
          filters={filters}
          setFilters={setFilters}
          selected={selected}
          setSelected={setSelected}
        />
      ) : (
        <FrozenTraceBody
          entries={frozenEntries}
          filters={filters}
          setFilters={setFilters}
          selected={selected}
          setSelected={setSelected}
        />
      )}
    </SheetContent>
  );
}

function TraceCounters({ paused }: { paused: boolean }) {
  const snapshot = useTraceStore();
  return (
    <div className="flex flex-1 flex-wrap items-center gap-3 text-meta text-muted-foreground">
      <span>captured {snapshot.entries.length + snapshot.ringDropped}</span>
      <span>ring dropped {snapshot.ringDropped}</span>
      <span>tap errors {snapshot.tapErrors}</span>
      {paused ? <span className="font-medium text-status-warning">frozen</span> : null}
    </div>
  );
}

type TraceBodyProps = {
  filters: TraceFilterState;
  setFilters: React.Dispatch<React.SetStateAction<TraceFilterState>>;
  selected: EventRecord | null;
  setSelected: React.Dispatch<React.SetStateAction<EventRecord | null>>;
};

function LiveTraceBody(props: TraceBodyProps) {
  const entries = useTraceStore().entries;
  return <TraceBody entries={entries} following {...props} />;
}

const FrozenTraceBody = memo(function FrozenTraceBody({
  entries,
  ...props
}: TraceBodyProps & { entries: readonly EventRecord[] }) {
  return <TraceBody entries={entries} following={false} {...props} />;
});

function TraceBody({
  entries,
  following,
  filters,
  setFilters,
  selected,
  setSelected,
}: TraceBodyProps & { entries: readonly EventRecord[]; following: boolean }) {
  const filteredEntries = useMemo(() => filterTraceEntries(entries, filters), [entries, filters]);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <StreamList
        entries={entries}
        selectedStreamId={filters.streamId}
        onSelect={(streamId) => setFilters((current) => ({ ...current, streamId }))}
      />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TraceFilters entries={entries} filters={filters} onChange={setFilters} />
        <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
          <TraceTable
            entries={filteredEntries}
            following={following}
            selected={selected}
            onSelect={setSelected}
          />
          <aside className="max-h-64 overflow-auto border-t border-border p-2 xl:max-h-none xl:w-96 xl:border-t-0 xl:border-l">
            <div className="mb-2 text-xs font-medium">Event detail</div>
            {selected ? (
              <JsonTree value={selected} className="max-h-none border-0 bg-transparent p-0" />
            ) : (
              <p className="text-meta text-muted-foreground">
                Select a row to inspect its full record.
              </p>
            )}
          </aside>
        </div>
        <TraceExport entries={filteredEntries} />
      </main>
    </div>
  );
}
