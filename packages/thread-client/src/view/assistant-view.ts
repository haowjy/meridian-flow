import type { SaveOutcome } from "@meridian/contracts/agents";
import {
  type Block,
  blockPlainText,
  TOOL_NOT_RUN_CODE,
  TOOL_STOPPED_CODE,
  type Turn,
} from "@meridian/contracts/protocol";
import type { SavedReportContentValue } from "@meridian/contracts/spawn";
import type { WorkReceipt } from "@meridian/contracts/works";
import { sameJson } from "../turns/same-turn";
import { componentBlockContent } from "./component-block-content";
import { groupDeliverySegments, type ToolView } from "./group-delivery-segments";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import {
  hiddenToolCallIds,
  partitionTurn,
  type RenderItem,
  visibleReasoningText,
} from "./partition-turn";
import { type FoldDigest, foldDigest } from "./thinking-digest";
import { agentsSaved, workReceipt } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";

export type ViewRun =
  | { kind: "reasoning"; blocks: Block[]; texts: string[] }
  | { kind: "activity"; blocks: Block[]; tools: ToolView[] };

export type ViewItem =
  | {
      kind: "process";
      runs: ViewRun[];
      visible: boolean;
      digest: FoldDigest;
    }
  | { kind: "text"; block: Block; text: string }
  | { kind: "report"; block: Block; report: SavedReportContentValue }
  | {
      kind: "artifact";
      block: Block;
      direct: DirectInvocationResult | null;
      cardKind: string | null;
      text: string | null;
    };

export type AssistantView = {
  blocks: Block[];
  items: ViewItem[];
  finalFrom: number;
  hiddenToolCallIds: string[];
  workReceipts: WorkReceipt[];
  wroteDocuments: boolean;
  agentsSaved: SaveOutcome[];
};

const cache = new WeakMap<readonly Block[], { status: Turn["status"]; view: AssistantView }>();
const itemCache = new WeakMap<Block, ViewItem>();

export function viewAssistantTurn(turn: Pick<Turn, "blocks" | "status">): AssistantView {
  const cached = cache.get(turn.blocks);
  if (cached?.status === turn.status) return cached.view;
  const blocks = [...turn.blocks].sort((a, b) => a.sequence - b.sequence);
  const direct = directResultsForTurn(blocks);
  const segments = groupDeliverySegments(blocks);
  const tools = segments.flatMap((segment) =>
    segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [],
  );
  if (turn.status === "cancelled" || turn.status === "error") tools.forEach(settleUnanswered);
  const hidden = hiddenToolCallIds(segments);
  const items = partitionTurn(segments, hidden).map((item) => internItem(viewItem(item, direct)));
  const view: AssistantView = {
    blocks,
    items,
    finalFrom: lastProcessIndex(items) + 1,
    hiddenToolCallIds: [...hidden],
    workReceipts: tools.flatMap((tool) => {
      const receipt = workReceipt(tool);
      return receipt ? [receipt] : [];
    }),
    wroteDocuments: tools.some((tool) => tool.toolName === "write"),
    agentsSaved: tools.flatMap(agentsSaved),
  };
  cache.set(turn.blocks, { status: turn.status, view });
  return view;
}

function settleUnanswered(tool: ToolView): void {
  if (tool.result !== null || tool.isError) return;
  tool.result =
    tool.status === "partial"
      ? { code: TOOL_NOT_RUN_CODE, message: "Didn't run." }
      : { code: TOOL_STOPPED_CODE, message: "Stopped." };
  tool.isError = true;
  tool.status = "complete";
}

function internItem(item: ViewItem): ViewItem {
  const anchor = firstBlock(item);
  if (!anchor) return item;
  const previous = itemCache.get(anchor);
  if (previous && sameViewItem(previous, item)) return previous;
  itemCache.set(anchor, item);
  return item;
}

function firstBlock(item: ViewItem): Block | undefined {
  if (item.kind !== "process") return item.block;
  return item.runs[0]?.blocks[0];
}

function sameBlocks(left: readonly Block[], right: readonly Block[]): boolean {
  return left.length === right.length && left.every((block, index) => block === right[index]);
}

function sameTool(left: ToolView, right: ToolView): boolean {
  const fields = {
    toolCallId: "value",
    toolName: "value",
    input: "json",
    result: "json",
    status: "value",
    isError: "value",
    message: "value",
    streamedOutput: "value",
    connectionCalls: "json",
    metadata: "json",
    keyBlock: "reference",
  } satisfies Record<keyof ToolView, "value" | "json" | "reference">;
  return (Object.keys(fields) as (keyof ToolView)[]).every((field) =>
    fields[field] === "json" ? sameJson(left[field], right[field]) : left[field] === right[field],
  );
}

function sameRun(left: ViewRun, right: ViewRun): boolean {
  if (left.kind !== right.kind || !sameBlocks(left.blocks, right.blocks)) return false;
  if (left.kind === "reasoning" && right.kind === "reasoning") {
    const fields = {
      kind: "value",
      blocks: "references",
      texts: "json",
    } satisfies Record<keyof typeof left, "value" | "references" | "json">;
    return (Object.keys(fields) as (keyof typeof left)[]).every((field) => {
      if (fields[field] === "references") return sameBlocks(left.blocks, right.blocks);
      if (fields[field] === "json") return sameJson(left[field], right[field]);
      return left[field] === right[field];
    });
  }
  if (left.kind === "activity" && right.kind === "activity") {
    const fields = {
      kind: "value",
      blocks: "references",
      tools: "tools",
    } satisfies Record<keyof typeof left, "value" | "references" | "tools">;
    return (Object.keys(fields) as (keyof typeof left)[]).every((field) => {
      if (fields[field] === "references") return sameBlocks(left.blocks, right.blocks);
      if (fields[field] === "tools")
        return (
          left.tools.length === right.tools.length &&
          left.tools.every((tool, index) => {
            const other = right.tools[index];
            return other ? sameTool(tool, other) : false;
          })
        );
      return left[field] === right[field];
    });
  }
  return false;
}

type ViewItemComparison = "value" | "reference" | "json" | "runs";

function sameItemFields<T extends ViewItem>(
  left: T,
  right: T,
  fields: Record<keyof T, ViewItemComparison>,
): boolean {
  return (Object.keys(fields) as (keyof T)[]).every((field) => {
    const comparison = fields[field];
    if (comparison === "json") return sameJson(left[field], right[field]);
    if (comparison === "runs") {
      const leftRuns = left[field] as ViewRun[];
      const rightRuns = right[field] as ViewRun[];
      return (
        leftRuns.length === rightRuns.length &&
        leftRuns.every((run, index) => {
          const other = rightRuns[index];
          return other ? sameRun(run, other) : false;
        })
      );
    }
    return left[field] === right[field];
  });
}

function sameViewItem(left: ViewItem, right: ViewItem): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "process": {
      if (right.kind !== "process") return false;
      const fields = {
        kind: "value",
        runs: "runs",
        visible: "value",
        digest: "json",
      } satisfies Record<keyof typeof left, ViewItemComparison>;
      return sameItemFields(left, right, fields);
    }
    case "text": {
      if (right.kind !== "text") return false;
      const fields = {
        kind: "value",
        block: "reference",
        text: "value",
      } satisfies Record<keyof typeof left, ViewItemComparison>;
      return sameItemFields(left, right, fields);
    }
    case "report": {
      if (right.kind !== "report") return false;
      const fields = {
        kind: "value",
        block: "reference",
        report: "json",
      } satisfies Record<keyof typeof left, ViewItemComparison>;
      return sameItemFields(left, right, fields);
    }
    case "artifact": {
      if (right.kind !== "artifact") return false;
      const fields = {
        kind: "value",
        block: "reference",
        direct: "json",
        cardKind: "value",
        text: "value",
      } satisfies Record<keyof typeof left, ViewItemComparison>;
      return sameItemFields(left, right, fields);
    }
  }
}

function lastProcessIndex(items: readonly ViewItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index]?.kind === "process") return index;
  }
  return -1;
}

function viewItem(item: RenderItem, direct: Map<string, DirectInvocationResult>): ViewItem {
  switch (item.kind) {
    case "process": {
      const runs = item.runs.map((run): ViewRun => {
        if (run.kind === "reasoning")
          return { ...run, texts: run.blocks.map((block) => visibleReasoningText(block) ?? "") };
        return { ...run, tools: run.tools.filter(isToolViewVisible) };
      });
      const tools = runs.flatMap((run) => (run.kind === "activity" ? run.tools : []));
      return {
        kind: "process",
        runs,
        visible: runs.some((run) => run.kind === "reasoning") || tools.length > 0,
        digest: foldDigest(tools),
      };
    }
    case "text":
      return { kind: "text", block: item.block, text: item.block.textContent ?? "" };
    case "report":
      return item;
    case "artifact":
      return artifactItem(item.block, direct.get(item.block.id) ?? null);
  }
}

function artifactItem(block: Block, direct: DirectInvocationResult | null): ViewItem {
  return {
    kind: "artifact",
    block,
    direct,
    cardKind:
      block.blockType === "custom" ? (componentBlockContent(block.content)?.kind ?? null) : null,
    text: block.blockType === "custom" ? null : plainRowText(block),
  };
}

function plainRowText(block: Block): string | null {
  const raw = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  if (raw) return raw;
  if (block.content && typeof block.content === "object" && !Array.isArray(block.content)) {
    const summary = (block.content as Record<string, unknown>).summary;
    if (typeof summary === "string") return summary;
  }
  return null;
}
