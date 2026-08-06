/** Human lenses over the same canonical model-request records consumed by the CLI. */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import { deriveModelRequestDebugViews } from "@meridian/contracts/threads";

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
  const views = deriveModelRequestDebugViews(records).filter(
    (view) => gatewayCallId === undefined || view.record.gatewayCallId === gatewayCallId,
  );

  return (
    <div className="space-y-3">
      {retention ? (
        <p className="font-mono text-meta text-muted-foreground">
          retained {retention.retainedRecords} requests ({retention.retainedBytes} bytes), dropped{" "}
          {retention.droppedRecords} ({retention.droppedBytes} bytes)
        </p>
      ) : null}
      {views.length === 0 ? (
        <p className="text-meta text-muted-foreground">
          No captured model request matches this gateway call.
        </p>
      ) : null}
      {views.map((view) => {
        const { record, prefix } = view;
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
        };

        return (
          <article
            key={record.gatewayCallId}
            className="overflow-hidden rounded border border-border-subtle bg-muted"
          >
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 font-mono text-meta">
              <span>iteration {record.iteration}</span>
              <span>{record.request?.model ?? "routing default"}</span>
              <span>prefix {prefix.status}</span>
              <span className="break-all text-muted-foreground">{record.requestDigest}</span>
            </header>
            <Tabs defaultValue="readable" className="gap-0">
              <TabsList className="px-3 pt-2">
                <TabsTrigger value="readable" className="text-xs">
                  Readable
                </TabsTrigger>
                <TabsTrigger value="raw" className="text-xs">
                  Raw
                </TabsTrigger>
                <TabsTrigger value="debug" className="text-xs">
                  Debug
                </TabsTrigger>
              </TabsList>
              <TabsContent value="readable" className="max-h-[40rem] overflow-auto p-3">
                <Markdown variant="compact">{view.markdown}</Markdown>
              </TabsContent>
              <TabsContent value="raw" className="p-3">
                <JsonTree
                  value={record.request}
                  className="max-h-[40rem] border-0 bg-transparent p-0"
                />
              </TabsContent>
              <TabsContent value="debug" className="p-3">
                <JsonTree
                  value={debugMetadata}
                  className="max-h-[40rem] border-0 bg-transparent p-0"
                />
              </TabsContent>
            </Tabs>
          </article>
        );
      })}
    </div>
  );
}
