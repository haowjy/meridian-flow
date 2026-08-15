/**
 * Review prose width — the left rail's transient yield while inline review runs.
 *
 * Only the Editor screen has a manuscript for the inline diff to land on, and
 * there review wants the rail's width for the prose. That yield is DERIVED from
 * `inlineReview !== null`: the shell renders the rail collapsed without ever
 * writing the writer's saved rail preference, so the preference reappears by
 * itself when review exits. Nothing is captured on entry, so a second draft
 * opened mid-review or a project change underneath cannot leave a stale
 * snapshot behind (the defect this replaced).
 *
 * The one stateful bit is the escape hatch: an explicit expand while review is
 * running releases the yield for the rest of that review, so the rail toggle is
 * never a dead control. The yield re-arms the next time review opens.
 */
import { useCallback, useEffect, useState } from "react";

import { type DesktopProjectSlotId, NO_COLLAPSED_SLOTS } from "@/features/project/layout";
import type { ScreenKey } from "@/features/project/shell/screens";

import type { DraftReviewContextValue } from "./DraftReviewProvider";

const RAIL_YIELDED: readonly DesktopProjectSlotId[] = ["rail-l"];

export type ReviewProseFocus = {
  /** Slots review holds collapsed; hand straight to `useProjectLayout`. */
  collapsedSlots: readonly DesktopProjectSlotId[];
  /** The writer asked for the rail back — stop holding it for this review. */
  release: () => void;
};

export function useReviewProseFocus(
  screen: ScreenKey,
  review: DraftReviewContextValue,
): ReviewProseFocus {
  const { controller } = review;
  const yielding = screen === "context" && controller.inlineReview !== null;
  const [released, setReleased] = useState(false);
  const release = useCallback(() => setReleased(true), []);
  // Re-arm on both edges: leaving review clears a release, and entering review
  // again (or returning to the Editor screen mid-review) yields afresh.
  useEffect(() => {
    setReleased(false);
  }, [yielding]);

  return {
    collapsedSlots: yielding && !released ? RAIL_YIELDED : NO_COLLAPSED_SLOTS,
    release,
  };
}
