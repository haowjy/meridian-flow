/**
 * Pop-out window for inspecting captured EventRecords without blocking the app.
 * i18n exception: this build-gated debug feature uses inline English by design.
 */
import type { EventRecord } from "@meridian/contracts/observability";
import { memo, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

import { DebugPopout, type DebugPopoutTarget, openDebugPopoutWindow } from "../DebugPopout";
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

export type TraceViewerTarget = DebugPopoutTarget;

export function openTraceViewerWindow(): TraceViewerTarget | null {
  return openDebugPopoutWindow({
    name: "meridian-trace-viewer",
    title: "Meridian Streams",
  });
}

export function TraceViewer({
  target,
  onClose,
}: {
  target: TraceViewerTarget | null;
  onClose: (target: TraceViewerTarget) => void;
}) {
  return (
    <DebugPopout target={target} onClose={onClose}>
      <TraceViewerContent />
    </DebugPopout>
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
    <section
      className="flex h-svh min-h-0 flex-col bg-background text-foreground"
      aria-label="Trace viewer"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
        <div>
          <h1 className="text-sm font-semibold">Streams</h1>
          <p className="text-meta text-muted-foreground">Live client observability events</p>
        </div>
        <TraceCounters paused={paused} />
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="text-meta"
          onClick={togglePaused}
        >
          {paused ? "Resume live tail" : "Pause / freeze"}
        </Button>
        <Button type="button" variant="outline" size="xs" className="text-meta" onClick={clear}>
          Clear
        </Button>
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
    </section>
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
  const selectedInView = selected !== null && filteredEntries.includes(selected);

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
            selected={selectedInView ? selected : null}
            onSelect={setSelected}
          />
          <aside className="max-h-64 overflow-auto border-t border-border p-2 xl:max-h-none xl:w-96 xl:border-t-0 xl:border-l">
            <div className="mb-2 text-xs font-medium">Event detail</div>
            {selectedInView ? (
              <JsonTree value={selected} className="max-h-none border-0 bg-transparent p-0" />
            ) : selected ? (
              <p className="text-meta text-muted-foreground">
                The selected event is outside the active filters or is no longer retained.
              </p>
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
