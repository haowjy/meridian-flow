/** Pop-out dashboard joining gateway lifecycle events with canonical model requests. */

import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { EventRecord } from "@meridian/contracts/observability";
import type { ModelRequestDebugListResponse } from "@meridian/contracts/protocol";
import type { ModelResponse } from "@meridian/contracts/threads";
import { useEffect, useMemo, useState } from "react";

import { getJson, isMeridianApiError } from "@/client/api/http-client";
import { getThreadModelRequestDebugRecords, getThreadSnapshot } from "@/client/api/threads-api";
import { Button } from "@/components/ui/button";
import { cacheHitPercent } from "@/features/chat/turn-stats";
import { cn } from "@/lib/utils";
import { DebugPopout, type DebugPopoutTarget, openDebugPopoutWindow } from "../DebugPopout";
import { JsonTree } from "../JsonTree";
import { ModelRequestInspector } from "../model-requests/ModelRequestInspector";
import type { LlmCallsScope } from "../use-debug-enabled";
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
  filter,
  onShowAll,
}: {
  target: LlmCallsViewerTarget | null;
  onClose: (target: LlmCallsViewerTarget) => void;
  filter?: LlmCallsScope;
  onShowAll?: () => void;
}) {
  return (
    <DebugPopout target={target} onClose={onClose}>
      <LlmCallsContent filter={filter} onShowAll={onShowAll} />
    </DebugPopout>
  );
}

function LlmCallsContent({
  filter,
  onShowAll,
}: {
  filter?: LlmCallsScope;
  onShowAll?: () => void;
}) {
  const { i18n } = useLingui();
  const [state, setState] = useState<CallsState>({ status: "loading" });
  const [responsesByTurn, setResponsesByTurn] = useState<Record<string, ModelResponse[]>>({});

  useEffect(() => {
    let active = true;
    setResponsesByTurn({});
    if (!filter)
      return () => {
        active = false;
      };
    void getThreadSnapshot({ data: { threadId: filter.threadId } })
      .then((snapshot) => {
        if (!active) return;
        setResponsesByTurn(
          Object.fromEntries(snapshot.turns.map((turn) => [turn.id, turn.responses])),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [filter]);

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

  const allCalls = useMemo(
    () => (state.status === "loaded" ? deriveLlmCalls(state.events) : []),
    [state],
  );
  const calls = useMemo(
    () =>
      filter
        ? allCalls.filter(
            (call) =>
              call.threadId === filter.threadId &&
              ("turnId" in filter
                ? call.turnId === filter.turnId
                : filter.turnIds.includes(call.turnId ?? "")),
          )
        : allCalls,
    [allCalls, filter],
  );
  const cacheResponseByCall = useMemo(() => {
    const result = new Map<string, ModelResponse>();
    const byTurn = new Map<string, LlmCallSummary[]>();
    for (const call of allCalls) {
      if (!call.turnId || !call.threadId || (filter && call.threadId !== filter.threadId)) continue;
      const turnCalls = byTurn.get(call.turnId) ?? [];
      turnCalls.push(call);
      byTurn.set(call.turnId, turnCalls);
    }
    for (const [turnId, responses] of Object.entries(responsesByTurn)) {
      const turnCalls = (byTurn.get(turnId) ?? [])
        .filter((call) => call.outcome === "ok")
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const available = [...responses].sort((a, b) => a.sequence - b.sequence);
      for (const call of turnCalls) {
        const responseIndex = available.findIndex((response) => response.model === call.model);
        if (responseIndex < 0) continue;
        const [response] = available.splice(responseIndex, 1);
        if (response) result.set(call.gatewayCallId, response);
      }
    }
    return result;
  }, [allCalls, filter, responsesByTurn]);

  return (
    <section
      className="flex min-h-svh flex-col bg-background text-foreground"
      aria-label="LLM calls"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
        <div>
          <h1 className="text-sm font-semibold">LLM Calls</h1>
          <p className="text-meta text-muted-foreground">
            Gateway lifecycle and canonical model requests, refreshed while this window is open
          </p>
          {filter ? (
            <div className="mt-1 flex items-center gap-3">
              <p className="font-mono text-meta text-muted-foreground">
                Thread {filter.threadId},{" "}
                {"turnId" in filter
                  ? `turn ${filter.turnId}`
                  : i18n._(t`Turns ${filter.turnIds.join(", ")}`)}
              </p>
              <button
                type="button"
                className="focus-ring rounded-sm text-meta text-primary underline"
                onClick={onShowAll}
              >
                Show all
              </button>
            </div>
          ) : null}
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
            {filter
              ? "No calls match this thread and turn. The viewer refreshes while this window is open."
              : "No gateway calls are retained. Start a generation, then leave this window open to refresh."}
          </p>
        ) : null}
        {calls.length > 0 ? (
          <div className="mx-auto flex max-w-6xl flex-col gap-2">
            {calls.map((call) => (
              <CallCard
                key={call.gatewayCallId}
                call={call}
                response={cacheResponseByCall.get(call.gatewayCallId)}
              />
            ))}
          </div>
        ) : null}
      </main>
    </section>
  );
}

function CallCard({ call, response }: { call: LlmCallSummary; response?: ModelResponse }) {
  const [expanded, setExpanded] = useState(false);
  const responseCacheHit =
    response?.cacheReadTokens == null
      ? null
      : cacheHitPercent(response.cacheReadTokens, response.inputTokens);
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
          {response ? (
            <>
              <Metric
                label="cache hit"
                value={
                  responseCacheHit == null ? "Not reported" : `${responseCacheHit.toFixed(1)}%`
                }
              />
              <Metric label="cache reset" value={response.cacheReset ? "Yes" : "No"} />
            </>
          ) : null}
        </dl>
        {correlation.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 break-all font-mono text-meta text-muted-foreground">
            {correlation.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
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
    <div className="space-y-3 border-t border-border p-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(22rem,1.2fr)]">
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
        </div>

        <section className="min-w-0">
          <h2 className="mb-2 text-xs font-medium">Raw lifecycle records</h2>
          <JsonTree value={call.lifecycleEvents} className="max-h-[34rem]" />
        </section>
      </div>
      {call.threadId && call.turnId ? <ModelRequestDetail call={call} /> : null}
    </div>
  );
}

type ModelRequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; response: ModelRequestDebugListResponse }
  | { status: "disabled" }
  | { status: "error"; message: string };

function ModelRequestDetail({ call }: { call: LlmCallSummary }) {
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<ModelRequestState>({ status: "idle" });
  const threadId = call.threadId;
  const turnId = call.turnId;

  function load() {
    if (!threadId || !turnId) return;
    setState({ status: "loading" });
    void getThreadModelRequestDebugRecords({
      data: { threadId, turnId, gatewayCallId: call.gatewayCallId },
    })
      .then((response) => {
        setState({ status: "loaded", response });
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

  function toggle() {
    if (visible) {
      setVisible(false);
      return;
    }
    setVisible(true);
    if (state.status === "idle" || state.status === "error") load();
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
            <div className="flex items-center gap-2">
              <p className="text-meta text-destructive">{state.message}</p>
              <Button type="button" variant="outline" size="xs" onClick={load}>
                Retry request
              </Button>
            </div>
          ) : null}
          {state.status === "loaded" && state.response.records.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              No captured model request matches this call.
            </p>
          ) : null}
          {state.status === "loaded" && state.response.records.length > 0 ? (
            <ModelRequestInspector
              records={state.response.records}
              retention={state.response.retention}
              gatewayCallId={call.gatewayCallId}
            />
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
    return `close${typeof outcome === "string" ? ` (${outcome})` : ""}`;
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
