import type {
  ShownLink as CorrespondenceShownLink,
  FrontierLookup,
  ObservationFrontier,
  ReplyMutations,
  ShownBlock,
} from "@meridian/agent-edit/integration";
import type { LinkView, ProjectId } from "@meridian/contracts";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";

export type { FrontierLookup, ObservationFrontier, ReplyMutations, ShownBlock };

export interface ShownLink extends CorrespondenceShownLink {
  view: string;
}

export interface ShownLinkShowing {
  documentId: string;
  holderUri: string;
  view: LinkView;
  links: readonly SpelledLinkFact[];
}

export const TREE_NAMES_ROOM = "tree";

export type FrontierRooms = { room: string } | { documentId: string };

export interface ResultEvidence {
  shown: readonly ShownLinkShowing[];
  frontier?: ObservationFrontier;
  names?: ObservationFrontier;
}

export function evidenceFrontiers(
  blockId: string,
  evidence: Pick<ResultEvidence, "frontier" | "names">,
): { blockId: string; frontier: ObservationFrontier }[] {
  return [evidence.frontier, evidence.names].flatMap((frontier) =>
    frontier ? [{ blockId, frontier }] : [],
  );
}

export interface StoredEvidence {
  projectId: ProjectId;
  threadId: string;
  turnId: string;
  shown: readonly ShownLinkShowing[];
  frontiers: readonly { blockId: string; frontier: ObservationFrontier }[];
}

export function linkViewKey(view: LinkView): string {
  return view.kind === "draft" ? `draft:${view.draftId}` : "live";
}

export interface LineageSegment {
  threadId: ThreadId;
  maxPosition: number | null;
}

export interface ThreadLineageLookup {
  thread(
    threadId: ThreadId,
  ): Promise<{ originType: string | null; originTurnId: string | null } | null>;
  turn(turnId: string): Promise<{ threadId: string; position: number } | null>;
}

export async function shownLinkLineage(
  threadId: ThreadId,
  lookup: ThreadLineageLookup,
): Promise<LineageSegment[]> {
  const segments: LineageSegment[] = [{ threadId, maxPosition: null }];
  const visited = new Set<string>([threadId]);
  let current: ThreadId = threadId;
  let cap: number | null = null;
  for (;;) {
    const thread = await lookup.thread(current);
    if (thread?.originType !== "fork" || !thread.originTurnId) return segments;
    const cutoff = await lookup.turn(thread.originTurnId);
    if (!cutoff || visited.has(cutoff.threadId)) return segments;
    cap = cap === null ? cutoff.position : Math.min(cap, cutoff.position);
    current = cutoff.threadId as ThreadId;
    visited.add(current);
    segments.push({ threadId: current, maxPosition: cap });
  }
}

export function latestShowings(rows: readonly ShownLink[]): ShownLink[] {
  const latest = new Map<string, ShownLink>();
  for (const row of rows) {
    const key = JSON.stringify([row.ref, row.address, row.holderUri, row.view]);
    const existing = latest.get(key);
    if (!existing || existing.at < row.at) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}
