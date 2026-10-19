// The region check (C3, C5, C8): a write isn't applied where the passage changed since the model saw it.
import * as Y from "yjs";
import { windowOf } from "../apply/echo.js";
import { changedWords, frontierBlockId, type ObservationFrontier } from "../frontier.js";
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
  /** The planning frontier the view was built from; null when the room has no valid one. */
  planned: ObservationFrontier | null;
}

/**
 * The room blocks a refusal shows, or null when the write may proceed. The region is the
 * targets' window on the plan doc; in the room it spans each window's surviving blocks and
 * whatever top-level blocks were inserted between them. Refused with no valid frontier, a
 * region block F left unshown, or more than the budget of changed words in the region between
 * the view's cut and the room's (clipped to the flipped ranges, so text typed and deleted in
 * between counts nothing, nor do the reply's own updates, which both cuts hold).
 */
export function regionRefusal(input: RegionCheckInput): Y.XmlElement[] | null {
  const viewBlocks = getTopLevelXmlBlocks(input.planDoc);
  const roomBlocks = getTopLevelXmlBlocks(input.room);
  const roomIndex = new Map(roomBlocks.map((block, index) => [blockId(block), index]));
  const indexes =
    input.targets === "all"
      ? viewBlocks.map((_, index) => index)
      : windowOf(input.targets, viewBlocks.length);
  const viewRegion = new Set(indexes.map((index) => blockId(viewBlocks[index])));
  const region = new Set(viewRegion);
  const shown = new Set<number>();
  for (const run of contiguousRuns(indexes)) {
    const positions = run.flatMap((index) => {
      const position = roomIndex.get(blockId(viewBlocks[index]));
      return position === undefined ? [] : [position];
    });
    if (positions.length === 0) continue;
    for (let position = Math.min(...positions); position <= Math.max(...positions); position += 1) {
      shown.add(position);
      region.add(blockId(roomBlocks[position]));
    }
  }
  const refused =
    !input.planned ||
    input.planned.unshown.some((id) => viewRegion.has(id)) ||
    changedWords(input.room, Y.snapshot(input.planDoc), Y.snapshot(input.room), region) >
      REGION_CHANGE_BUDGET_WORDS;
  return refused ? [...shown].sort((a, b) => a - b).map((position) => roomBlocks[position]) : null;
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
