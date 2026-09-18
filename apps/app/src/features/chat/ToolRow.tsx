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
 * (the custom interrupt card for `ask_user`). Their tool_use / tool_result
 * blocks are duplication when rendered as activity rows; the shared visibility
 * predicate keeps the rendered rows and process digest in agreement.
 */

import { memo, useMemo } from "react";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import { descriptorFor } from "./command-descriptor";
import type { ToolView } from "./group-delivery-segments";
import type { WriteMode } from "./tool-command";
import { rendererFor } from "./tool-renderers";
import { isToolViewVisible } from "./tool-view-visibility";

export type ToolRowProps = {
  tool: ToolView;
  writeMode?: WriteMode;
};

function ToolRowComponent({ tool, writeMode = "direct" }: ToolRowProps) {
  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : tool.isError ? "error" : "done";
  const presentation = useMemo(
    () => ({
      title: renderer.title(tool, { writeMode }),
      expand: renderer.expand?.(tool) ?? undefined,
    }),
    [renderer, tool, writeMode],
  );
  if (!isToolViewVisible(tool)) return null;

  return (
    <ActivityRow
      Icon={descriptorFor(tool).Icon}
      title={presentation.title}
      status={status}
      expand={presentation.expand}
    />
  );
}

export const ToolRow = memo(ToolRowComponent);
ToolRow.displayName = "ToolRow";
