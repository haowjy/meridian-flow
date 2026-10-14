/**
 * What a room's writers see of its frame once command records are taken into account: the frame's changes
 * minus the ones an Apply has taken off the screen, each with the failure its last Apply left. Pure; the
 * review runtime derives it once per room, and readers select from it.
 */
import {
  type AppliedChange,
  appliedChanges,
  type ChangeFailure,
  changeFailure,
  type DraftCommandRecords,
  type DraftRef,
} from "@/client/query/draft-command-record";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import { appliedIn, type ReviewFrame } from "./review-frame";
import type { ReviewChange } from "./review-model";

export type VisibleChange = {
  change: ReviewChange;
  /** Why the last Apply of this change did not land. */
  failure: ChangeFailure | null;
};

export type ReviewVisible = {
  visible: readonly VisibleChange[];
  /** The applied entries in force: the manuscript stops painting the changes they name. */
  applied: readonly AppliedChange[];
  /**
   * Applies still waiting for an answer whose change the frame no longer has (a peer removed it): the
   * writer's action has no row to say it is out, so the file does, and says why if it fails.
   */
  unplaced: number;
};

export const NO_VISIBLE: ReviewVisible = { visible: [], applied: [], unplaced: 0 };

export function deriveVisible(
  frame: ReviewFrame,
  changes: readonly ReviewChange[],
  records: DraftCommandRecords,
  draft: DraftRef,
): ReviewVisible {
  const { ids, live } = appliedIn(frame, appliedChanges(records, draft));
  return {
    visible: changes
      .filter((change) => !ids.has(change.id))
      .map((change) => ({ change, failure: changeFailure(records, draft, change) })),
    applied: live,
    unplaced: live.filter(
      (entry) =>
        entry.phase === "sent" &&
        !frame.groups.some((group) => isSameChange(entry, group.id, frame.pins.get(group.id))),
    ).length,
  };
}
