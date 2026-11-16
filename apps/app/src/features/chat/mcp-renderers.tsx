/**
 * Rows for the connection tools. `mcp_call` names the connection and its tool, and opens to what
 * was sent and what came back; a failure says why and, where the writer can fix it, how.
 * `mcp_describe` is the AI reading a tool's arguments: a step with nothing to open.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { McpCallResult } from "@meridian/contracts/mcp";
import type { JsonValue } from "@meridian/contracts/protocol";
import {
  mcpCall,
  mcpCallFailed,
  mcpRun,
  mcpRunFailed,
  type ToolView,
} from "@meridian/thread-client";
import type { ReactNode } from "react";
import { useMcpConnections, useRouteProjectId } from "@/client/query/useMcpConnections";
import { Button } from "@/components/ui/button";
import { useSettingsNavigation } from "@/features/account/SettingsDialog";
import { useTryAgain } from "@/features/connections/ConnectionRow";
import { connectionStanding } from "@/features/connections/connection-status";
import { formatBytes } from "@/lib/format-size";
import { BoundLine, ExpandableProse } from "./ClippedExpand";
import { CommandTitle } from "./CommandTitle";
import { descriptorFor, mcpToolLabel, toolActivityPhrase } from "./command-descriptor";
import { scriptPhrase } from "./script-copy";
import { failureText } from "./tool-failure";
import type { ToolRenderer } from "./tool-renderers";

function phrase(tool: ToolView): ReactNode {
  const { verb, parameter } = toolActivityPhrase(tool);
  return (
    <CommandTitle
      verb={verb}
      parameter={parameter ? <span className="min-w-0 truncate">{parameter}</span> : undefined}
    />
  );
}

export const MCP_CALL_RENDERER: ToolRenderer = {
  title: (tool) => {
    if (tool.status !== "complete" || !mcpCallFailed(tool)) return phrase(tool);
    const { connection, tool: name } = mcpCall(tool);
    if (!connection || !name) return descriptorFor(tool).failureVerb();
    return (
      <CommandTitle
        verb={t`Couldn't use`}
        parameter={
          <span className="min-w-0 truncate">{`${connection}: ${mcpToolLabel(connection, name)}`}</span>
        }
      />
    );
  },
  expand: (tool) => {
    const call = mcpCall(tool);
    if (!call.arguments && !call.result && !tool.isError) return null;
    return () => <McpCallDetail tool={tool} />;
  },
};

export const MCP_RUN_RENDERER: ToolRenderer = {
  // Not `phrase`: a failed script says why it stopped, where a failed row says only what it couldn't do.
  title: (tool) => {
    const { verb, parameter } = scriptPhrase(tool);
    return (
      <CommandTitle
        verb={verb}
        parameter={parameter ? <span className="min-w-0 truncate">{parameter}</span> : undefined}
      />
    );
  },
  expand: (tool, renderRow) => {
    const { code, calls, result } = mcpRun(tool);
    if (!code && !calls.length && !result) return null;
    return () => <McpRunDetail tool={tool} renderRow={renderRow} />;
  },
};

export const MCP_DESCRIBE_RENDERER: ToolRenderer = {
  title: (tool) => (tool.isError ? descriptorFor(tool).failureVerb() : phrase(tool)),
  expand: (tool) => {
    const text = describedText(tool.result);
    if (!text) return null;
    return () => (
      <ExpandableProse more={<Trans>Show all</Trans>}>
        <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {text}
        </pre>
      </ExpandableProse>
    );
  },
};

/** What the AI read: the tools' arguments, or a connection's tool list. */
function describedText(result: JsonValue | null): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  return typeof result.text === "string" && result.text ? result.text : null;
}

/** The script and, under it, one row per call: the same row an `mcp_call` has. */
function McpRunDetail({
  tool,
  renderRow,
}: {
  tool: ToolView;
  renderRow: (tool: ToolView) => ReactNode;
}) {
  const { code, calls, result } = mcpRun(tool);
  const failed = tool.status === "complete" && mcpRunFailed(tool);
  const where = result?.error?.line;
  return (
    <div className="space-y-[var(--chat-space-inline)]">
      {failed && result?.error ? (
        <p className="text-compact text-destructive">
          {where !== undefined ? <Trans>Line {where}: </Trans> : null}
          {result.error.message}
        </p>
      ) : null}
      {code ? (
        <Part label={<Trans>Script</Trans>}>
          <ExpandableProse more={<Trans>Show more</Trans>}>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {code}
            </pre>
          </ExpandableProse>
        </Part>
      ) : null}
      {calls.length ? (
        <Part label={<Trans>Calls</Trans>}>
          {calls.map((call) => (
            <div key={call.toolCallId}>{renderRow(call)}</div>
          ))}
        </Part>
      ) : null}
      {result?.logs?.text ? (
        <Part label={<Trans>Printed</Trans>}>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {result.logs.text}
          </pre>
        </Part>
      ) : null}
    </div>
  );
}

function McpCallDetail({ tool }: { tool: ToolView }) {
  const { arguments: sent, result } = mcpCall(tool);
  const failed = tool.status === "complete" && mcpCallFailed(tool);
  const reply = result?.reply;
  return (
    <div className="space-y-[var(--chat-space-inline)]">
      {failed ? <CallFailure tool={tool} result={result} /> : null}
      {sent ? (
        <Part label={<Trans>Sent</Trans>}>
          <Data value={sent} />
        </Part>
      ) : null}
      {reply ? (
        <Part label={<Trans>Reply</Trans>}>
          {reply.text ? (
            <ExpandableProse more={<Trans>Show more</Trans>}>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                {reply.text}
              </pre>
            </ExpandableProse>
          ) : null}
          {reply.media?.length ? (
            <ul className="mt-1 space-y-0.5">
              {reply.media.map((part) => (
                <li key={part.ref.uri} className="text-compact text-foreground">
                  {part.name}{" "}
                  <span className="text-muted-foreground">
                    ({mediaKind(part.mediaType)}, {formatBytes(part.sizeBytes)})
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {reply.cut ? (
            <BoundLine>
              <Trans>The reply was cut short: this is the part the AI read.</Trans>
            </BoundLine>
          ) : null}
        </Part>
      ) : null}
    </div>
  );
}

/**
 * "PNG", "JPEG", "SVG": what a reply's picture is. The bytes live only in the chat's own copy, which
 * no route serves to the app, so the row names the picture rather than linking to it.
 */
function mediaKind(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.split(/[+;]/)[0];
  return subtype ? subtype.toUpperCase() : mediaType;
}

function Part({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-0.5 text-xs font-medium text-muted-foreground">{label}</h4>
      {children}
    </section>
  );
}

function Data({ value }: { value: Record<string, JsonValue> }) {
  if (Object.keys(value).length === 0)
    return (
      <p className="text-compact text-muted-foreground">
        <Trans>Nothing</Trans>
      </p>
    );
  return (
    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink-fill px-2 py-1.5 font-mono text-xs text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * Why the call failed. A connection that couldn't be reached or refused its token is the writer's
 * to fix: Try again runs a check, never the call, and the line then says how the connection stands.
 */
function CallFailure({ tool, result }: { tool: ToolView; result: McpCallResult | null }) {
  const text = tool.result != null ? failureText(tool.result) : t`This call failed.`;
  const fixable = result?.outcome === "unreachable" || result?.outcome === "unauthorized";
  return (
    <div className="flex flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-1">
      <p className="text-compact text-destructive">{text}</p>
      {fixable && result?.connection ? <ConnectionFix name={result.connection} /> : null}
    </div>
  );
}

function ConnectionFix({ name }: { name: string }) {
  const list = useMcpConnections(useRouteProjectId());
  const connection = list.data?.find((item) => item.name === name && !item.shadowedBy);
  if (!connection) return null;
  return <ConnectionFixFor connection={connection} />;
}

function ConnectionFixFor({
  connection,
}: {
  connection: NonNullable<ReturnType<typeof useMcpConnections>["data"]>[number];
}) {
  const tryAgain = useTryAgain(connection);
  const settings = useSettingsNavigation();
  const standing = connectionStanding(connection, tryAgain.isPending);
  const name = connection.name;
  if (standing.kind === "checking")
    return (
      <span className="text-compact text-muted-foreground">
        <Trans>Checking {name}…</Trans>
      </span>
    );
  if (standing.kind === "working" || standing.kind === "no_tools")
    return (
      <span className="text-compact text-muted-foreground">
        <Trans>{name} answers now. Ask the AI to try again.</Trans>
      </span>
    );
  if (standing.kind === "problem" && standing.status === "needs_sign_in")
    return (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => settings.open("connections")}
      >
        <Trans>Update the token</Trans>
      </Button>
    );
  return (
    <Button type="button" variant="outline" size="xs" onClick={() => tryAgain.mutate()}>
      <Trans>Try again</Trans>
    </Button>
  );
}
