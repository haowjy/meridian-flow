/** partition-turn — turns an ordered `Block[]` into the ordered render items the transcript draws. */
import { parseInvocationCard } from "@meridian/contracts/components";
import {
  type Block,
  blockContentRecord,
  blockPlainText,
  type JsonValue,
} from "@meridian/contracts/protocol";
import { isArtifactRef } from "./ArtifactGrid";
import { isToolDeliveryBlock } from "./block-kind";
import { componentBlockContent } from "./component-block-content";
import { groupDeliverySegments } from "./group-delivery-segments";
import type { ReportContentValue } from "./ReportContent";
import { isArtifactBlock } from "./tool-kind";
import { isToolViewVisible } from "./tool-view-visibility";

export type Run = { kind: "reasoning"; blocks: Block[] } | { kind: "activity"; blocks: Block[] };

export type RenderItem =
  | { kind: "process"; runs: Run[] }
  | { kind: "text"; block: Block }
  | { kind: "report"; block: Block; report: ReportContentValue }
  | { kind: "artifact"; block: Block };

/** The writer-facing answer is the prose/report suffix after the final process fold. */
export function finalMessageItems(items: RenderItem[]): RenderItem[] {
  return items.slice(lastProcessIndex(items) + 1);
}

/** Index of the final process fold, shared by answer selection and delivery placement. */
export function lastProcessIndex(items: RenderItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]?.kind === "process") return index;
  }
  return -1;
}

export function isReasoningBlock(block: Block): boolean {
  return block.blockType === "reasoning" || block.blockType === "thinking";
}

export function partitionTurn(blocks: Block[]): RenderItem[] {
  const hidden = hiddenToolCallIds(blocks);
  const reportCalls = new Set(
    blocks.flatMap((block) => {
      if (block.blockType !== "tool_use") return [];
      const content = blockContentRecord(block);
      return content.toolName === "return_result" && typeof content.toolCallId === "string"
        ? [content.toolCallId]
        : [];
    }),
  );
  // return_result's typed result: `{ ok: true }`, `{ ok: false, message }`,
  // or an executor error `{ code, message }`.
  const resultByCall = new Map<string, Record<string, JsonValue>>();
  for (const block of blocks) {
    if (block.blockType !== "tool_result") continue;
    const content = blockContentRecord(block);
    if (typeof content.toolCallId === "string" && isRecord(content.result)) {
      resultByCall.set(content.toolCallId, content.result);
    }
  }
  const items: RenderItem[] = [];
  let runs: Run[] | null = null;

  const flushProcess = () => {
    if (runs && runs.length > 0) items.push({ kind: "process", runs });
    runs = null;
  };
  const pushProcessBlock = (runKind: Run["kind"], block: Block) => {
    if (!runs) runs = [];
    const last = runs[runs.length - 1];
    if (last && last.kind === runKind) last.blocks.push(block);
    else runs.push({ kind: runKind, blocks: [block] } as Run);
  };

  for (const block of blocks) {
    if (isToolDeliveryBlock(block)) {
      const content = blockContentRecord(block);
      const toolCallId = content.toolCallId;
      if (block.blockType === "tool_use" && content.toolName === "return_result") {
        const input = isRecord(content.input) ? content.input : {};
        const result = typeof toolCallId === "string" ? resultByCall.get(toolCallId) : undefined;
        flushProcess();
        items.push({
          kind: "report",
          block,
          report: {
            summary: typeof input.summary === "string" ? input.summary : "",
            ...(input.payload === undefined ? {} : { payload: input.payload }),
            artifacts: Array.isArray(input.artifacts) ? input.artifacts.filter(isArtifactRef) : [],
            partial: result?.ok === false || content.isError === true,
            ...(typeof result?.message === "string" ? { reason: result.message } : {}),
          },
        });
        continue;
      }
      if (
        block.blockType === "tool_result" &&
        typeof toolCallId === "string" &&
        reportCalls.has(toolCallId)
      ) {
        continue;
      }
      if (typeof toolCallId === "string" && hidden.has(toolCallId)) continue;
      pushProcessBlock("activity", block);
      continue;
    }

    if (isReasoningBlock(block)) {
      if (hasVisibleReasoningText(block)) pushProcessBlock("reasoning", block);
      continue;
    }

    if (block.blockType === "text") {
      if (!block.textContent?.trim()) continue;
      flushProcess();
      items.push({ kind: "text", block });
      continue;
    }

    // AG-UI progress placeholders parked under a non-canonical blockType are
    // transport liveness, not deliverable content.
    if (block.blockType === ("activity" as Block["blockType"])) continue;

    if (isArtifactBlock(block)) {
      flushProcess();
      items.push({ kind: "artifact", block });
      continue;
    }

    // Unknown non-canonical block: keep it visible rather than folding it away.
    flushProcess();
    items.push({ kind: "artifact", block });
  }

  flushProcess();
  return items;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tool calls the writer sees elsewhere: a call whose helper card is in the
 * turn shows as that card alone, and the per-tool policy covers the rest. A
 * `thread_message` refused before it started has no card, so its failure row
 * stays.
 */
function hiddenToolCallIds(blocks: Block[]): Set<string> {
  const hidden = new Set<string>();
  for (const block of blocks) {
    if (block.blockType !== "custom") continue;
    const card = parseInvocationCard(componentBlockContent(block.content));
    if (card) hidden.add(card.toolCallId);
  }
  for (const segment of groupDeliverySegments(blocks)) {
    const tools =
      segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [];
    for (const tool of tools) {
      if (!isToolViewVisible(tool) && tool.toolCallId) hidden.add(tool.toolCallId);
    }
  }
  return hidden;
}

/**
 * Empty reasoning is a provider repair placeholder, not writer-facing thought.
 * Dropping it keeps a blank block from opening an empty Thinking fold.
 */
export function visibleReasoningText(block: Block): string | null {
  const text = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  return text || null;
}

export function hasVisibleReasoningText(block: Block): boolean {
  return visibleReasoningText(block) !== null;
}
