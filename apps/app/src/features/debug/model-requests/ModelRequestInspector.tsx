/** Human lenses over the same canonical model-request records consumed by the CLI. */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import {
  deriveModelRequestDebugViews,
  renderModelRequestDebugMarkdown,
  summarizeModelRequestDebugView,
} from "@meridian/contracts/threads";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Markdown } from "@/rich-content/Markdown";

import { JsonTree } from "../JsonTree";

export function ModelRequestInspector({
  records,
  retention,
  gatewayCallId,
}: {
  records: readonly ModelRequestDebugRecord[];
  retention?: ModelRequestDebugRetention;
  gatewayCallId?: string;
}) {
  const [selectedCallId, setSelectedCallId] = useState<string>();
  const available = deriveModelRequestDebugViews(records);
  const matching = gatewayCallId
    ? available.filter((view) => view.record.gatewayCallId === gatewayCallId)
    : available;
  const view =
    matching.find((candidate) => candidate.record.gatewayCallId === selectedCallId) ??
    matching.at(-1);

  return (
    <div className="space-y-3">
      {retention && retention.droppedRecords > 0 ? (
        <p className="rounded border border-border-subtle bg-muted px-3 py-2 text-meta text-muted-foreground">
          This capture ring has evicted {retention.droppedRecords} requests totaling{" "}
          {formatBytes(retention.droppedBytes)}. Earlier context may be unavailable.
        </p>
      ) : null}
      {!gatewayCallId && matching.length > 1 ? (
        <Select value={view?.record.gatewayCallId} onValueChange={setSelectedCallId}>
          <SelectTrigger
            size="sm"
            aria-label="Model request iteration"
            className="font-mono text-meta"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {matching.map((candidate) => (
              <SelectItem
                key={candidate.record.gatewayCallId}
                value={candidate.record.gatewayCallId}
              >
                iteration {candidate.record.iteration} ({candidate.prefix.status})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {view ? <ModelRequestView view={view} retention={retention} /> : null}
      {!view ? (
        <p className="text-meta text-muted-foreground">
          No captured model request matches this gateway call.
        </p>
      ) : null}
    </div>
  );
}

function ModelRequestView({
  view,
  retention,
}: {
  view: ReturnType<typeof deriveModelRequestDebugViews>[number];
  retention?: ModelRequestDebugRetention;
}) {
  const { record, prefix } = view;
  const requestSummary = summarizeModelRequestDebugView(view);
  const prefixSummary = prefixPresentation(requestSummary);
  const debugMetadata = {
    schema: record.schema,
    gatewayCallId: record.gatewayCallId,
    threadId: record.threadId,
    turnId: record.turnId,
    iteration: record.iteration,
    requestedAt: record.requestedAt,
    agentSlug: record.agentSlug,
    requestDigest: record.requestDigest,
    requestBytes: record.requestBytes,
    capture: record.capture,
    prefix,
    skills: record.skills,
    toolRegistrations: record.toolRegistrations,
    retention,
  };

  return (
    <article className="overflow-hidden rounded border border-border-subtle bg-muted">
      <header className="space-y-3 border-b border-border-subtle px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Iteration {record.iteration}</h3>
            <p className="font-mono text-meta text-muted-foreground">
              {requestSummary.model ?? "Routing default"}
            </p>
          </div>
          <Badge>{prefixSummary.label}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <RequestMetric label="messages" value={formatCount(requestSummary.messageCount)} />
          <RequestMetric
            label="advertised tools"
            value={formatCount(requestSummary.advertisedToolCount)}
          />
          <RequestMetric label="request size" value={formatBytes(requestSummary.requestBytes)} />
        </dl>
        {prefixSummary.detail ? (
          <p className="text-meta text-muted-foreground">{prefixSummary.detail}</p>
        ) : null}
      </header>
      <Tabs defaultValue="readable" className="gap-0">
        <TabsList className="px-3 pt-2">
          <TabsTrigger value="readable" className="text-xs">
            Markdown
          </TabsTrigger>
          <TabsTrigger value="raw" className="text-xs">
            Raw
          </TabsTrigger>
          <TabsTrigger value="debug" className="text-xs">
            Debug
          </TabsTrigger>
        </TabsList>
        <TabsContent value="readable" className="max-h-[40rem] overflow-auto p-3">
          <Markdown variant="compact">{renderModelRequestDebugMarkdown(view)}</Markdown>
        </TabsContent>
        <TabsContent value="raw" className="p-3">
          <JsonTree value={record.request} className="max-h-[40rem] border-0 bg-transparent p-0" />
        </TabsContent>
        <TabsContent value="debug" className="p-3">
          <JsonTree value={debugMetadata} className="max-h-[40rem] border-0 bg-transparent p-0" />
        </TabsContent>
      </Tabs>
    </article>
  );
}

function RequestMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-meta text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs text-foreground">{value}</dd>
    </div>
  );
}

function prefixPresentation(summary: ReturnType<typeof summarizeModelRequestDebugView>): {
  label: string;
  detail: string | null;
} {
  if (summary.prefix.status === "first") {
    return { label: "First request", detail: null };
  }
  if (summary.prefix.status === "exact") {
    const preserved = summary.prefix.preservedMessageCount;
    const appended = summary.prefix.appendedMessageCount ?? 0;
    return {
      label: "Exact prefix",
      detail: `${formatCountedNoun(preserved, "earlier message")} preserved. ${formatCountedNoun(appended, "message")} appended.`,
    };
  }
  if (summary.prefix.status === "changed") {
    return {
      label: "Earlier context changed",
      detail: "The preceding messages or gateway parameters are not an exact prefix.",
    };
  }
  return {
    label: "Comparison unavailable",
    detail: "The immediately preceding request was not retained with a complete body.",
  };
}

function formatCount(value: number | null): string {
  return value === null ? "Unavailable" : value.toLocaleString();
}

function formatCountedNoun(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}
