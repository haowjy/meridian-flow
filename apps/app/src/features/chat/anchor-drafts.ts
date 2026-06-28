/**
 * anchor-drafts — split active thread draft groups into the assistant turn
 * that produced them vs. groups whose producing turn isn't in the transcript
 * (or is unknown). The chat surface renders the former inline beneath the
 * producing assistant turn and the latter in a single compact fallback strip
 * above the Composer.
 *
 * Stays a tiny pure helper so the rendering layer can stay dumb about lookup.
 */

import type { Turn } from "@meridian/contracts/protocol";

import type { ThreadDraftGroup } from "@/client/query/useThreadDrafts";

export type AnchoredDraftSplit = {
  /** Groups keyed by the assistant turn that produced them. */
  byTurnId: Map<string, ThreadDraftGroup[]>;
  /** Groups with no producing turn id, or whose turn isn't in the transcript. */
  unanchored: ThreadDraftGroup[];
};

export function splitDraftGroupsByTurn(
  groups: ThreadDraftGroup[] | null | undefined,
  turns: Turn[],
): AnchoredDraftSplit {
  if (!groups || groups.length === 0) {
    return { byTurnId: new Map(), unanchored: [] };
  }

  const turnIds = new Set<string>();
  for (const turn of turns) turnIds.add(turn.id);

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
