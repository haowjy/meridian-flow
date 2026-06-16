/**
 * ToolRow — adapter from a normalized `ToolView` to one row in the activity
 * timeline.
 *
 * Thin binding: it picks the registered renderer for the tool name, evaluates
 * the title/expand/click for the current view, and hands the result to the
 * shared `ActivityRow` primitive. Replaces the boxed `ToolCard`; one logical
 * tool invocation is now a single text-altitude row.
 *
 * Hidden tools: a few "tools" are protocol primitives whose UX lives elsewhere
 * (the custom checkpoint card for `ask_user`). Their tool_use / tool_result
 * blocks are duplication when rendered as activity rows — see
 * `shouldHideToolView` below.
 */

import type { JsonValue } from "@meridian/contracts/protocol";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

export type ToolRowProps = {
  tool: ToolView;
};

export function ToolRow({ tool }: ToolRowProps) {
  if (shouldHideToolView(tool)) return null;

  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : tool.isError ? "error" : "done";
  const expand = renderer.expand ? (renderer.expand(tool) ?? undefined) : undefined;
  const onClick = renderer.onClick ? () => renderer.onClick?.(tool) : undefined;

  return (
    <ActivityRow
      Icon={renderer.Icon}
      iconTint={renderer.iconTint}
      title={renderer.title(tool)}
      status={status}
      expand={expand}
      onClick={onClick}
    />
  );
}

/**
 * `ask_user` is the checkpoint mechanism — the model fires it to pause for
 * user input, and the actual interaction surface is the `custom` checkpoint
 * block (free-text or choice card). Rendering the tool_use and its eventual
 * tool_result as activity rows would duplicate the question and answer the
 * checkpoint card already shows in place.
 *
 * Two flavours of view need hiding:
 *   1. The named tool_use itself (`toolName === "ask_user"`).
 *   2. An orphan tool_result whose `tool_use` was broken off into an earlier
 *      run by the segmenter (checkpoint block sits between them). The result
 *      lacks `toolName` so it falls back to `"tool"`; we identify it by the
 *      checkpoint-result output shape (`{ value, provenance }`).
 */
function shouldHideToolView(tool: ToolView): boolean {
  if (tool.toolName === "ask_user") return true;
  if (tool.toolName === "tool" && isCheckpointResultOutput(tool.output)) return true;
  return false;
}

function isCheckpointResultOutput(output: JsonValue | null): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, JsonValue>;
  return "provenance" in record && "value" in record;
}
