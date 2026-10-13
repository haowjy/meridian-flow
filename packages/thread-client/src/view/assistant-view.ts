/**
 * assistant-view — what one assistant turn shows: its blocks folded into the ordered items the
 * writer sees (process folds, prose, reports, artifacts), with the fold's visible tools, digest
 * counts, the hidden protocol halves and the turn's Work receipts decided here once.
 */
import type { Block, Turn } from "@meridian/contracts/protocol";
import type { SavedReportContentValue } from "@meridian/contracts/spawn";
import type { WorkReceipt } from "@meridian/contracts/works";
import {
  type DeliverySegment,
  groupDeliverySegments,
  type ToolView,
} from "./group-delivery-segments";
import { type DirectInvocationResult, directResultsForTurn } from "./invocation-direct-result";
import { hiddenToolCallIds, partitionTurn, type RenderItem } from "./partition-turn";
import { type FoldDigest, foldDigest } from "./thinking-digest";
import { turnWorkReceipts } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";

export type ViewRun =
  | { kind: "reasoning"; blocks: Block[] }
  /** The fold's visible tool calls, paired and in order. Hidden halves are not here. */
  | { kind: "activity"; blocks: Block[]; tools: ToolView[] };

export type ViewItem =
  | {
      kind: "process";
      runs: ViewRun[];
      /** A fold earns its disclosure only when it holds reasoning or a visible tool. */
      visible: boolean;
      digest: FoldDigest;
    }
  | { kind: "text"; block: Block; text: string }
  | { kind: "report"; block: Block; report: SavedReportContentValue }
  | { kind: "artifact"; block: Block; direct: DirectInvocationResult | null };

export type AssistantView = {
  /** The turn's blocks in sequence order. */
  blocks: Block[];
  items: ViewItem[];
  /** Where the writer-facing answer starts: the item after the final process fold. */
  finalFrom: number;
  /** Tool calls the writer sees elsewhere (a card, or the per-tool policy), so they have no row. */
  hiddenToolCallIds: string[];
  workReceipts: WorkReceipt[];
};

const cache = new WeakMap<readonly Block[], AssistantView>();

/** Memoized by the turn's `blocks` array: an unchanged turn keeps its view, so React rows stay still. */
export function viewAssistantTurn(turn: Pick<Turn, "blocks">): AssistantView {
  const cached = cache.get(turn.blocks);
  if (cached) return cached;
  const blocks = [...turn.blocks].sort((a, b) => a.sequence - b.sequence);
  const direct = directResultsForTurn(blocks);
  const items = partitionTurn(blocks).map((item) => viewItem(item, direct));
  const view: AssistantView = {
    blocks,
    items,
    finalFrom: lastProcessIndex(items) + 1,
    hiddenToolCallIds: [...hiddenToolCallIds(blocks)],
    workReceipts: turnWorkReceipts(blocks),
  };
  cache.set(turn.blocks, view);
  return view;
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
        if (run.kind === "reasoning") return run;
        return { ...run, tools: visibleTools(groupDeliverySegments(run.blocks)) };
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
      return { kind: "artifact", block: item.block, direct: direct.get(item.block.id) ?? null };
  }
}

function visibleTools(segments: readonly DeliverySegment[]): ToolView[] {
  return segments.flatMap((segment) => {
    if (segment.kind === "tool") return isToolViewVisible(segment.tool) ? [segment.tool] : [];
    if (segment.kind === "tool-run") return segment.tools.filter(isToolViewVisible);
    return [];
  });
}
