import { Trans } from "@lingui/react/macro";
import type { ToolView } from "@meridian/thread-client";
import { stringInput, threadMessageRow, toolInputObject } from "@meridian/thread-client";
import { SubagentRefLine } from "./thread-report-renderer";
import { errorMessageExpand } from "./tool-failure";
import type { ToolExpand, ToolRenderer } from "./tool-renderers";

function ThreadMessageTitle({ tool }: { tool: ToolView }) {
  const row = threadMessageRow(tool);
  const handle =
    row?.kind === "queued" ? row.message.handle : (stringInput(toolInputObject(tool), "ref") ?? "");
  const line =
    row?.kind === "queued" && row.message.name ? (
      <>
        {row.message.name} <span className="text-muted-foreground">({handle})</span>
      </>
    ) : (
      <SubagentRefLine handle={handle} />
    );
  if (row?.kind === "queued") return <Trans>Sent a message to {line}</Trans>;
  return <Trans>Couldn't send a message to {line}</Trans>;
}

function threadMessageExpand(tool: ToolView): ToolExpand | null {
  const message = stringInput(toolInputObject(tool), "message");
  const failure = errorMessageExpand(tool);
  if (!message) return failure;
  return () => (
    <>
      {failure?.()}
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{message}</p>
    </>
  );
}

export const THREAD_MESSAGE_RENDERER: ToolRenderer = {
  title: (tool) => <ThreadMessageTitle tool={tool} />,
  expand: threadMessageExpand,
};
