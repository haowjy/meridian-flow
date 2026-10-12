/**
 * Fold row for a `thread_message` with no card: a queued message (the model
 * sent a subagent a message and moved on) or a call refused before any child
 * run started. A foreground re-task that ran is shown by its helper card
 * instead, and `tool-view-visibility` and `partitionTurn` hide its row.
 */

import { Trans } from "@lingui/react/macro";
import type { ToolView } from "./group-delivery-segments";
import { threadMessageRow } from "./thread-message-result";
import { SubagentRefLine } from "./thread-report-renderer";
import { stringInput, toolInputObject } from "./tool-command";
import type { ToolExpand, ToolRenderer } from "./tool-renderers";

function ThreadMessageTitle({ tool }: { tool: ToolView }) {
  const row = threadMessageRow(tool);
  const handle =
    row?.kind === "queued" ? row.message.handle : (stringInput(toolInputObject(tool), "ref") ?? "");
  const line = <SubagentRefLine handle={handle} />;
  if (row?.kind === "queued") return <Trans>Sent a message to {line}</Trans>;
  return <Trans>Couldn't send a message to {line}</Trans>;
}

/** The message itself, as the model wrote it to the subagent. */
function threadMessageExpand(tool: ToolView): ToolExpand | null {
  const message = stringInput(toolInputObject(tool), "message");
  if (!message) return null;
  return () => (
    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{message}</p>
  );
}

export const THREAD_MESSAGE_RENDERER: ToolRenderer = {
  title: (tool) => <ThreadMessageTitle tool={tool} />,
  expand: threadMessageExpand,
};
