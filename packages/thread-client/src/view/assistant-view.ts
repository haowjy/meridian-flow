/**
 * assistant-view — what one assistant turn shows: its blocks folded into the ordered items the
 * writer sees (process folds, prose, reports, artifacts), with the fold's visible tools, digest
 * counts, the hidden protocol halves and the turn's Work receipts decided here once.
 */
import { type Block, blockPlainText, type Turn } from "@meridian/contracts/protocol";
import type { SavedReportContentValue } from "@meridian/contracts/spawn";
import type { WorkReceipt } from "@meridian/contracts/works";
import { isImageBlock } from "./block-kind";
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
import { workReceipt } from "./tool-command";
import { isToolViewVisible } from "./tool-view-visibility";

export type ViewRun =
  /** `texts[i]` is the visible thought of `blocks[i]`: what the writer reads, wherever the block keeps it. */
  | { kind: "reasoning"; blocks: Block[]; texts: string[] }
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
  | {
      kind: "artifact";
      block: Block;
      direct: DirectInvocationResult | null;
      /** A custom card's kind; null for other blocks. The card draws its own words from `block.content`. */
      cardKind: string | null;
      /** What a block without a card or image draws as a plain row; null when it draws nothing. */
      text: string | null;
    };

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
  const segments = groupDeliverySegments(blocks);
  const hidden = hiddenToolCallIds(segments);
  const items = partitionTurn(segments, hidden).map((item) => viewItem(item, direct));
  const tools = segments.flatMap((segment) =>
    segment.kind === "tool" ? [segment.tool] : segment.kind === "tool-run" ? segment.tools : [],
  );
  const view: AssistantView = {
    blocks,
    items,
    finalFrom: lastProcessIndex(items) + 1,
    hiddenToolCallIds: [...hidden],
    workReceipts: tools.flatMap((tool) => {
      const receipt = workReceipt(tool);
      return receipt ? [receipt] : [];
    }),
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
    text: block.blockType === "custom" || isImageBlock(block) ? null : plainRowText(block),
  };
}

/** The body of a block drawn as a plain activity row. */
function plainRowText(block: Block): string | null {
  const raw = block.textContent?.trim() || blockPlainText(block.blockType, block.content)?.trim();
  if (raw) return raw;
  if (block.content && typeof block.content === "object" && !Array.isArray(block.content)) {
    const summary = (block.content as Record<string, unknown>).summary;
    if (typeof summary === "string") return summary;
  }
  return null;
}
