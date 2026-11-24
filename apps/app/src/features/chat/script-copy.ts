import { plural, t } from "@lingui/core/macro";
import type { McpRunResult } from "@meridian/contracts/mcp";
import { mcpRun, type ToolView } from "@meridian/thread-client";
import type { ToolActivityPhrase } from "./command-descriptor";

const calls = (count: number) => plural(count, { one: "# call", other: "# calls" });

const stoppedAfter = (count: number): string =>
  plural(count, {
    0: "Script stopped before its first call:",
    one: "Script stopped after # call:",
    other: "Script stopped after # calls:",
  });

function stopReason(result: McpRunResult): string {
  switch (result.ended) {
    case "timed_out": {
      const seconds = Math.round((result.limitMs ?? 0) / 1000);
      return result.limit === "cpu"
        ? t`used more than ${seconds} seconds of its own running time`
        : t`took longer than ${seconds} seconds`;
    }
    case "too_large": {
      const kilobytes = Math.round((result.bytes ?? 0) / 1000);
      return t`returned more than the AI can read (${kilobytes} KB)`;
    }
    case "aborted":
      return t`you stopped it`;
    default:
      return t`the script runner failed`;
  }
}

export function scriptPhrase(tool: ToolView): ToolActivityPhrase {
  const { result, calls: live } = mcpRun(tool);
  if (!result) {
    return live.length
      ? { verb: t`Running a script:`, parameter: `${calls(live.length)}…` }
      : { verb: t`Running a script…` };
  }
  const count = result.calls.length;
  switch (result.ended) {
    case "returned":
      return count
        ? { verb: t`Ran a script:`, parameter: calls(count) }
        : { verb: t`Ran a script` };
    case "threw":
      return {
        verb: plural(count, {
          0: "Script failed before its first call:",
          one: "Script failed after # call:",
          other: "Script failed after # calls:",
        }),
        parameter: result.error?.message.split("\n")[0] ?? "",
      };
    case "rejected_code":
      return { verb: t`Script couldn't run:`, parameter: t`its code didn't parse` };
    default:
      return { verb: stoppedAfter(count), parameter: stopReason(result) };
  }
}
