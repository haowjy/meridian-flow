/**
 * ToolRow — adapter from a normalized `ToolView` to one row in the activity
 * timeline.
 *
 * Thin binding: it picks the registered renderer for the tool name, evaluates
 * the title and optional expansion for the current view, and hands the result to the
 * shared `ActivityRow` primitive. Replaces the boxed `ToolCard`; one logical
 * tool invocation is now a single text-altitude row.
 *
 * Hidden tools: a few "tools" are protocol primitives whose UX lives elsewhere
 * (the custom interrupt card for `ask_user`). Their tool_use / tool_result
 * blocks are duplication when rendered as activity rows; the shared visibility
 * predicate keeps the rendered rows and process digest in agreement.
 */

import { memo, useMemo } from "react";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";
import { isToolViewVisible } from "./tool-view-visibility";

export type ToolRowProps = {
  tool: ToolView;
  writeMode?: "direct" | "draft";
};

function ToolRowComponent({ tool, writeMode = "direct" }: ToolRowProps) {
  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : tool.isError ? "error" : "done";
  const presentation = useMemo(
    () => ({
      title: renderer.title(tool, { writeMode }),
      expand: renderer.expand ? (renderer.expand(tool) ?? undefined) : undefined,
    }),
    [renderer, tool, writeMode],
  );
  if (!isToolViewVisible(tool)) return null;

  return (
    <ActivityRow
      Icon={renderer.Icon}
      title={presentation.title}
      status={status}
      expand={presentation.expand}
    />
  );
}

export const ToolRow = memo(ToolRowComponent);
ToolRow.displayName = "ToolRow";
