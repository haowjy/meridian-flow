import { t } from "@lingui/core/macro";
import { isToolNotRunResult } from "@meridian/contracts/protocol";
import type { ToolView, ViewItem } from "@meridian/thread-client";
import { liveToolActivityLabel } from "./command-descriptor";

const MOST_NAMED = 3;

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

function callLabel(tool: ToolView): string {
  return liveToolActivityLabel(tool.toolName, tool.input).replace(/…$/, "");
}

export function TurnStoppedLine({
  stopped,
  notRun,
}: {
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
