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
 * blocks are duplication when rendered as activity rows — see
 * `shouldHideToolView` below.
 */

import type { JsonValue } from "@meridian/contracts/protocol";
import { ActivityRow, type ActivityRowStatus } from "./ActivityRow";
import type { ToolView } from "./group-delivery-segments";
import { rendererFor } from "./tool-renderers";

export type ToolRowProps = {
  tool: ToolView;
  draftWrite?: boolean;
};

export function ToolRow({ tool, draftWrite = false }: ToolRowProps) {
  if (shouldHideToolView(tool)) return null;

  const renderer = rendererFor(tool.toolName);
  const status: ActivityRowStatus =
    tool.status === "partial" ? "running" : tool.isError ? "error" : "done";
  const expand = renderer.expand ? (renderer.expand(tool) ?? undefined) : undefined;

  return (
    <ActivityRow
      Icon={renderer.Icon}
      title={renderer.title(tool, { writeMode: draftWrite ? "draft" : "direct" })}
      status={status}
      expand={expand}
    />
  );
}

/**
 * `ask_user` is the interrupt mechanism — the model fires it to pause for
 * user input, and the actual interaction surface is the `custom` interrupt
 * block (free-text or choice card). Rendering the tool_use and its eventual
 * tool_result as activity rows would duplicate the question and answer the
 * interrupt card already shows in place.
 *
 * Two flavours of view need hiding:
 *   1. The named tool_use itself (`toolName === "ask_user"`).
 *   2. An orphan tool_result whose `tool_use` was broken off into an earlier
 *      run by the segmenter (interrupt block sits between them). The result
 *      lacks `toolName` so it falls back to `"tool"`; we identify it by the
 *      interrupt-result output shape (`{ value, provenance }`).
 */
function shouldHideToolView(tool: ToolView): boolean {
  if (tool.toolName === "ask_user") return true;
  if (tool.toolName === "tool" && isInterruptResultOutput(tool.output)) return true;
  return false;
}

function isInterruptResultOutput(output: JsonValue | null): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) return false;
  const record = output as Record<string, JsonValue>;
  return "provenance" in record && "value" in record;
}
