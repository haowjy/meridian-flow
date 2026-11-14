/** The plain line under a reply the run ended before it finished: that it stopped, and which calls never ran. */
import { t } from "@lingui/core/macro";
import { isToolNotRunResult } from "@meridian/contracts/protocol";
import type { ToolView, ViewItem } from "@meridian/thread-client";
import { liveToolActivityLabel } from "./command-descriptor";

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

/** The call as the writer's activity rows name it ("Writing Scene C"), without the in-flight ellipsis. */
function callLabel(tool: ToolView): string {
  return liveToolActivityLabel(tool.toolName, tool.input).replace(/…$/, "");
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
