/** Pop-out dashboard for metadata-only gateway call lifecycle events. */
import type { EventRecord } from "@meridian/contracts/observability";
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";
import { useEffect, useMemo, useState } from "react";

import { getJson, isMeridianApiError } from "@/client/api/http-client";
import { getThreadModelRequestDebugRecords } from "@/client/api/threads-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { DebugPopout, type DebugPopoutTarget, openDebugPopoutWindow } from "../DebugPopout";
import { JsonTree } from "../JsonTree";
import { deriveLlmCalls, type LlmCallOutcome, type LlmCallSummary } from "./derive-llm-calls";

const EVENTS_PATH = "/api/debug/events?source=gateway&excludeName=stream.chunk&limit=500";
const POLL_INTERVAL_MS = 3_000;

type EventQueryResponse = {
  events?: unknown;
  dropped?: unknown;
};

type CallsState =
  | { status: "loading" }
  | { status: "loaded"; events: unknown[]; dropped: number; updatedAt: Date }
  | { status: "error"; message: string };

const OUTCOME_CLASS: Record<LlmCallOutcome, string> = {
  "in-flight": "bg-status-live-bg text-status-live-foreground",
  ok: "bg-status-done-bg text-status-done-foreground",
  cancelled: "bg-review-warning-tint text-status-warning",
  error: "bg-destructive-tint text-destructive",
};

export type LlmCallsViewerTarget = DebugPopoutTarget;

export function openLlmCallsViewerWindow(): LlmCallsViewerTarget | null {
  return openDebugPopoutWindow({
    name: "meridian-llm-calls-viewer",
    title: "Meridian LLM Calls",
    width: 1180,
  });
}

export function LlmCallsViewer({
  target,
  onClose,
}: {
  target: LlmCallsViewerTarget | null;
  onClose: (target: LlmCallsViewerTarget) => void;
}) {
  return (
    <DebugPopout target={target} onClose={onClose}>
      <LlmCallsContent />
    </DebugPopout>
  );
}

function LlmCallsContent() {
  const [state, setState] = useState<CallsState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;

    async function poll() {
      request?.abort();
      const currentRequest = new AbortController();
      request = currentRequest;
      try {
        const response = await getJson<unknown>(EVENTS_PATH, {
          signal: currentRequest.signal,
        });
        if (!active || currentRequest.signal.aborted) return;
        const responseRecord =
          typeof response === "object" && response !== null && !Array.isArray(response)
            ? (response as EventQueryResponse)
            : {};
        setState({
          status: "loaded",
          events: Array.isArray(responseRecord.events) ? responseRecord.events : [],
          dropped: typeof responseRecord.dropped === "number" ? responseRecord.dropped : 0,
          updatedAt: new Date(),
        });
      } catch (error) {
        if (!active || currentRequest.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "request failed",
        });
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
      request?.abort();
    };
  }, []);

  const calls = useMemo(
    () => (state.status === "loaded" ? deriveLlmCalls(state.events) : []),
    [state],
  );

  return (
    <section
      className="flex min-h-svh flex-col bg-background text-foreground"
      aria-label="LLM calls"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
        <div>
          <h1 className="text-sm font-semibold">LLM Calls</h1>
          <p className="text-meta text-muted-foreground">
            Metadata-only gateway lifecycle, refreshed while this window is open
          </p>
        </div>
        {state.status === "loaded" ? (
          <div className="flex flex-1 flex-wrap items-center gap-3 text-meta text-muted-foreground">
            <span>{calls.length} calls</span>
            <span>{state.events.length} records</span>
            <span>{state.dropped} ring evictions</span>
            <span>updated {state.updatedAt.toLocaleTimeString()}</span>
          </div>
        ) : null}
      </header>

      <main className="min-h-0 flex-1 p-3">
        {state.status === "loading" ? (
          <p className="text-xs text-muted-foreground">Loading gateway events…</p>
        ) : null}
        {state.status === "error" ? (
          <p className="text-xs text-destructive" role="alert">
            Could not load gateway events: {state.message}
          </p>
        ) : null}
        {state.status === "loaded" && calls.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No gateway calls are retained. Start a generation, then leave this window open to
            refresh.
          </p>
        ) : null}
        {calls.length > 0 ? (
          <div className="mx-auto flex max-w-6xl flex-col gap-2">
            {calls.map((call) => (
              <CallCard key={call.gatewayCallId} call={call} />
            ))}
          </div>
        ) : null}
      </main>
    </section>
  );
}

function CallCard({ call }: { call: LlmCallSummary }) {
  const [expanded, setExpanded] = useState(false);
  const correlation = [
    call.threadId ? `thread ${call.threadId}` : null,
    call.turnId ? `turn ${call.turnId}` : null,
    call.iteration !== undefined ? `iteration ${call.iteration}` : null,
    call.agentSlug ? `agent ${call.agentSlug}` : null,
  ].filter(Boolean);

  return (
    <article className="overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        className="focus-ring block w-full p-3 text-left hover:bg-muted"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-medium text-foreground">
                {call.model ?? "unknown model"}
              </span>
              <span className="text-meta text-muted-foreground">
                {call.provider ?? "unknown provider"}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-medium text-meta",
                  OUTCOME_CLASS[call.outcome],
                )}
              >
                {call.outcome}
              </span>
            </div>
            <p className="mt-1 truncate font-mono text-meta text-muted-foreground">
              {call.gatewayCallId}
            </p>
          </div>
          <span className="shrink-0 text-meta text-muted-foreground">
            {new Date(call.startedAt).toLocaleString()}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          <Metric label="first output" value={formatMilliseconds(call.firstOutputMs)} />
          <Metric label="duration" value={formatMilliseconds(call.durationMs)} />
          <Metric label="input tokens" value={formatCount(call.inputTokens)} />
          <Metric label="output tokens" value={formatCount(call.outputTokens)} />
        </dl>
        {correlation.length > 0 ? (
          <p className="mt-2 break-all font-mono text-meta text-muted-foreground">
            {correlation.join(" · ")}
          </p>
        ) : null}
      </button>

      {expanded ? <CallDetail call={call} /> : null}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function CallDetail({ call }: { call: LlmCallSummary }) {
  const startedAt = Date.parse(call.startedAt);

  return (
    <div className="grid gap-3 border-t border-border p-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(22rem,1.2fr)]">
      <div className="space-y-3">
        <section>
          <h2 className="mb-2 text-xs font-medium">Lifecycle</h2>
          <ol className="space-y-1.5">
            {call.lifecycleEvents.map((event, index) => (
              <li
                key={event.eventId ?? `${event.stream?.observerSeq ?? index}:${event.name}`}
                className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 rounded border border-border-subtle bg-muted px-2 py-1.5"
              >
                <span className="font-mono text-meta text-muted-foreground">
                  +{relativeMilliseconds(startedAt, event.timestamp)} ms
                </span>
                <span className="min-w-0 font-mono text-meta text-foreground">
                  {timelineLabel(event)}
                </span>
              </li>
            ))}
          </ol>
        </section>

        {call.chunkCount > 0 ? (
          <section>
            <h2 className="mb-2 text-xs font-medium">Stream events ({call.chunkCount})</h2>
            <dl className="grid grid-cols-2 gap-1.5">
              {call.chunks.map((chunk) => (
                <div
                  key={chunk.messageClass}
                  className="flex justify-between gap-2 rounded border border-border-subtle bg-muted px-2 py-1.5"
                >
                  <dt className="truncate font-mono text-meta text-muted-foreground">
                    {chunk.messageClass}
                  </dt>
                  <dd className="font-mono text-meta text-foreground">{chunk.count}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        {call.threadId && call.turnId ? <ModelRequestDetail call={call} /> : null}
      </div>

      <section className="min-w-0">
        <h2 className="mb-2 text-xs font-medium">Raw lifecycle records</h2>
        <JsonTree value={call.lifecycleEvents} className="max-h-[34rem]" />
      </section>
    </div>
  );
}

type ModelRequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; records: ModelRequestDebugRecord[] }
  | { status: "disabled" }
  | { status: "error"; message: string };

function ModelRequestDetail({ call }: { call: LlmCallSummary }) {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<ModelRequestState>({ status: "idle" });
  const threadId = call.threadId;
  const turnId = call.turnId;

  function toggle() {
    if (visible) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (!threadId || !turnId || state.status !== "idle") return;

    setState({ status: "loading" });
    void getThreadModelRequestDebugRecords({ data: { threadId, turnId } })
      .then((response) => {
        const records =
          call.iteration === undefined
            ? response.records
            : response.records.filter((record) => record.iteration === call.iteration);
        setState({ status: "loaded", records });
      })
      .catch((error: unknown) => {
        if (isMeridianApiError(error) && error.code === "not_found") {
          setState({ status: "disabled" });
          return;
        }
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "request failed",
        });
      });
  }

  return (
    <section>
      <Button type="button" variant="outline" size="xs" className="text-meta" onClick={toggle}>
        {visible ? "Hide model request content" : "Show model request content"}
      </Button>
      {visible ? (
        <div className="mt-2">
          {state.status === "loading" ? (
            <p className="text-meta text-muted-foreground">Loading model request content…</p>
          ) : null}
          {state.status === "disabled" ? (
            <p className="text-meta text-muted-foreground">
              Model-request capture is disabled on this server.
            </p>
          ) : null}
          {state.status === "error" ? (
            <p className="text-meta text-destructive">{state.message}</p>
          ) : null}
          {state.status === "loaded" && state.records.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              No captured model request matches this call.
            </p>
          ) : null}
          {state.status === "loaded" && state.records.length > 0 ? (
            <JsonTree value={state.records} className="max-h-96" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function timelineLabel(event: EventRecord): string {
  if (event.name === "stream.retry") {
    const attempt = event.payload.attempt;
    return `retry${typeof attempt === "number" ? ` ${attempt}` : ""}`;
  }
  if (event.name === "stream.first_output") return "first output";
  if (event.name === "stream.close") {
    const outcome = event.payload.outcome;
    return `close${typeof outcome === "string" ? ` · ${outcome}` : ""}`;
  }
  return event.name.startsWith("stream.") ? event.name.slice("stream.".length) : event.name;
}

function relativeMilliseconds(startedAt: number, timestamp: string): string {
  const eventAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt) || !Number.isFinite(eventAt)) return "?";
  return Math.max(0, eventAt - startedAt).toLocaleString();
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toLocaleString()} ms`;
}

function formatCount(value: number | undefined): string {
  return value === undefined ? "n/a" : value.toLocaleString();
}
