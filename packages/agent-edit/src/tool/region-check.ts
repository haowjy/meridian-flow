// The region check (C3, C5, C8): a write isn't applied where the passage changed since the model saw it.
import * as Y from "yjs";
import { windowOf } from "../apply/echo.js";
import { changedWords, frontierBlockId } from "../frontier.js";
import { getBlockItemId, getTopLevelXmlBlocks } from "../model/block-hash.js";

/** More changed words than this inside the region refuses; a typo fix or short phrase merges. */
export const REGION_CHANGE_BUDGET_WORDS = 10;

/** A refusal shows its region up to this much text; past it, it names the range to read. */
export const REFUSAL_REGION_MAX_BYTES = 16 * 1024;

export interface RegionCheckInput {
  /** The doc the write planned on: the model's view, or the room copy when it had none. */
  planDoc: Y.Doc;
  /** The call's room copy. */
  room: Y.Doc;
  /** Target block indexes on `planDoc` (an anchorless insert is -1), or every block. */
  targets: readonly number[] | "all";
  /**
   * What the view was planned from: the planning frontier's unshown blocks (none from the
   * empty snapshot a document this reply created plans on); null when there was no valid one.
   */
  planned: { unshown: readonly string[] } | null;
}

/**
 * Why a write wasn't applied: the model hasn't seen all of the passage (no valid frontier, or
 * a region block it left unshown or never saw), or the passage changed since it saw it.
 */
export type RegionRefusalReason = "unseen" | "changed";

/**
 * Prepare shared cuts and indexes once; the returned check widens each group's targets once.
 * It returns the room blocks a refusal shows and why, or null when it may proceed. The region is
 * the targets' window on the plan doc; in the room it spans each window's surviving blocks and
 * whatever top-level blocks were inserted between them. Refused with no valid frontier, a
 * region block F left unshown, or more than the budget of changed words in the region between
 * the view's cut and the room's (clipped to the flipped ranges, so text typed and deleted in
 * between counts nothing, nor do the reply's own updates, which both cuts hold).
 */
export function createRegionCheck(input: Omit<RegionCheckInput, "targets">) {
  const viewBlocks = getTopLevelXmlBlocks(input.planDoc);
  const roomBlocks = getTopLevelXmlBlocks(input.room);
  const roomIndex = new Map(roomBlocks.map((block, index) => [blockId(block), index]));
  const viewSnapshot = Y.snapshot(input.planDoc);
  const roomSnapshot = Y.snapshot(input.room);
  return function regionRefusal(
    targets: RegionCheckInput["targets"],
  ): { blocks: Y.XmlElement[]; reason: RegionRefusalReason } | null {
    const indexes =
      targets === "all"
        ? viewBlocks.map((_, index) => index)
        : windowOf(targets, viewBlocks.length);
    const viewRegion = new Set(indexes.map((index) => blockId(viewBlocks[index])));
    const region = new Set(viewRegion);
    const shown = new Set<number>();
    for (const run of contiguousRuns(indexes)) {
      const positions = run.flatMap((index) => {
        const position = roomIndex.get(blockId(viewBlocks[index]));
        return position === undefined ? [] : [position];
      });
      if (positions.length === 0) continue;
      for (
        let position = Math.min(...positions);
        position <= Math.max(...positions);
        position += 1
      ) {
        shown.add(position);
        region.add(blockId(roomBlocks[position]));
      }
    }
    const reason: RegionRefusalReason | null =
      !input.planned || input.planned.unshown.some((id) => viewRegion.has(id))
        ? "unseen"
        : changedWords(input.room, viewSnapshot, roomSnapshot, region) > REGION_CHANGE_BUDGET_WORDS
          ? "changed"
          : null;
    if (!reason) return null;
    return {
      blocks: [...shown].sort((a, b) => a - b).map((position) => roomBlocks[position]),
      reason,
    };
  };
}

function blockId(block: Y.XmlElement): string {
  return frontierBlockId(getBlockItemId(block));
}

/** Sorted indexes split where they stop being consecutive. */
function contiguousRuns(indexes: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const index of indexes) {
    const run = runs.at(-1);
    if (run && index === (run.at(-1) as number) + 1) run.push(index);
    else runs.push([index]);
  }
  return runs;
}
