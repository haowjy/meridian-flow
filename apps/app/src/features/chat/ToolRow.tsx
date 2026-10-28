/**
 * ToolRow — adapter from a normalized `ToolView` to one row in the activity
 * timeline.
 *
 * Thin binding: it resolves the command (glyph + chip tone), picks the
 * registered renderer for the tool name, evaluates the title and optional
 * expansion for the current view, and hands the result to the shared
 * `ActivityRow` primitive. Replaces the boxed `ToolCard`; one logical tool
 * invocation is now a single text-altitude row.
 *
 * The glyph is bound to the **command**, not the tool. The icon column is
 * already a perfectly aligned vertical channel; spending it on tool identity
 * wastes it on something the writer does not care about, and it rendered
 * `Read Chapter 3` and `Edited Chapter 3` with the same pen.
 *
 * Hidden tools: a few "tools" are protocol primitives whose UX lives elsewhere
 * (`ask_user`, whose receipt sits on the asking turn). Their tool_use / tool_result
 * blocks are duplication when rendered as activity rows; the view model drops
 * them (`isToolViewVisible`) before a fold reaches this row.
 */

import { t } from "@lingui/core/macro";
import { isNotesStepHeldResult } from "@meridian/contracts/threads";
import type { ToolView } from "@meridian/thread-client";
import { Pause } from "lucide-react";
import { memo, useMemo } from "react";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import { descriptorFor } from "./command-descriptor";
import { rendererFor, toolRowFailed } from "./tool-renderers";

export type ToolRowProps = {
  tool: ToolView;
};

function ToolRowComponent({ tool }: ToolRowProps) {
  if (isNotesStepHeldResult(tool.result)) {
    return (
      <div data-tool-call-id={tool.toolCallId ?? undefined}>
        <ActivityRow Icon={Pause} title={t`Not run before compaction`} status="done" />
      </div>
    );
  }
  return <ExecutedToolRow tool={tool} />;
}

function ExecutedToolRow({ tool }: ToolRowProps) {
  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : toolRowFailed(tool) ? "error" : "done";
  const presentation = useMemo(
    () => ({
      title: renderer.title(tool),
      expand: renderer.expand?.(tool) ?? undefined,
    }),
    [renderer, tool],
  );
  return (
    <div data-tool-call-id={tool.toolCallId ?? undefined}>
      <ActivityRow
        Icon={descriptorFor(tool).Icon}
        title={presentation.title}
        status={status}
        expand={presentation.expand}
      />
    </div>
  );
}

export const ToolRow = memo(ToolRowComponent);
ToolRow.displayName = "ToolRow";
