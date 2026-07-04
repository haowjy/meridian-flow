/**
 * anchor-drafts — split reviewable thread draft groups into the assistant turn
 * that produced them vs. groups whose producing turn isn't in the transcript
 * (or is unknown). The chat surface renders the former inline beneath the
 * producing assistant turn and the latter in a single compact fallback strip
 * above the Composer.
 *
 * Takes a stable set of in-transcript turn ids rather than the live `Turn[]`
 * so that unrelated streaming/block churn doesn't bust the memoized split —
 * the set identity is what matters for anchoring, not the full turn objects.
 *
 * Stays a tiny pure helper so the rendering layer can stay dumb about lookup.
 */

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";

export type AnchoredDraftSplit = {
  /** Groups keyed by the assistant turn that produced them. */
  byTurnId: Map<string, ThreadDraftGroup[]>;
  /** Groups with no producing turn id, or whose turn isn't in the transcript. */
  unanchored: ThreadDraftGroup[];
};

export function splitDraftGroupsByTurn(
  groups: ThreadDraftGroup[] | null | undefined,
  turnIds: ReadonlySet<string>,
): AnchoredDraftSplit {
  if (!groups || groups.length === 0) {
    return { byTurnId: new Map(), unanchored: [] };
  }

  const byTurnId = new Map<string, ThreadDraftGroup[]>();
  const unanchored: ThreadDraftGroup[] = [];

  for (const group of groups) {
    // A group's anchor is the lastActorTurnId of its first draft today; if
    // multi-draft groups land later, the producing turn is still per-group
    // (it's the assistant edit run that put them up for review).
    const anchorTurnId = group.drafts[0]?.lastActorTurnId ?? null;
    if (anchorTurnId && turnIds.has(anchorTurnId)) {
      const existing = byTurnId.get(anchorTurnId);
      if (existing) existing.push(group);
      else byTurnId.set(anchorTurnId, [group]);
    } else {
      unanchored.push(group);
    }
  }

  return { byTurnId, unanchored };
}
