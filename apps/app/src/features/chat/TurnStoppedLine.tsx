/** The plain line under a reply the run ended before it finished: that it stopped, and which calls never ran. */
import { t } from "@lingui/core/macro";
import { isToolNotRunResult } from "@meridian/contracts/protocol";
import type { ToolView, ViewItem } from "@meridian/thread-client";
import { humanizeToolName } from "./command-descriptor";
import { documentDisplayName } from "./document-display-name";

const MOST_NAMED = 3;

/** The calls an ended reply asked for and never ran: stopped before they settled, or lost with the run. */
export function callsThatDidNotRun(items: readonly ViewItem[]): ToolView[] {
  return items.flatMap((item) =>
    item.kind === "process"
      ? item.runs.flatMap((run) =>
          run.kind === "activity"
            ? run.tools.filter(
                (tool) => tool.status === "partial" || isToolNotRunResult(tool.result),
              )
            : [],
        )
      : [],
  );
}

/** "create Scene C": what the call was going to do, when its input says. */
function callLabel(tool: ToolView): string {
  const input =
    tool.input && typeof tool.input === "object" && !Array.isArray(tool.input) ? tool.input : null;
  const path = typeof input?.path === "string" ? input.path : null;
  const command = typeof input?.command === "string" ? input.command : null;
  if (!path) return humanizeToolName(tool.toolName);
  return `${command ?? humanizeToolName(tool.toolName)} ${documentDisplayName(path)}`;
}

export function TurnStoppedLine({
  stopped,
  notRun,
}: {
  /** The writer (or a Send now) stopped the reply, as opposed to a crash that has its own failure card. */
  stopped: boolean;
  notRun: readonly ToolView[];
}) {
  const named = notRun.slice(0, MOST_NAMED).map(callLabel).join(", ");
  const more = notRun.length - MOST_NAMED;
  const calls = more > 0 ? t`${named} and ${more} more` : named;
  const text = !notRun.length
    ? t`Stopped.`
    : stopped
      ? t`Stopped. Didn't run: ${calls}.`
      : t`Didn't run: ${calls}.`;
  return (
    <p className="text-xs text-muted-foreground" data-turn-stopped>
      {text}
    </p>
  );
}
