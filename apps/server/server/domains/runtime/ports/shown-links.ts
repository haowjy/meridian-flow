/**
 * Shown-link evidence (contract §7.3): every link the model was shown in a
 * holder document, per thread, with the address, holder URI and view it was
 * shown in. Ref assignment reads it through `WriteContext.shownLinks`; the
 * model never sees it. Rows outlive compaction and restart, rolled-back
 * responses keep theirs, and a fork reads its source's rows up to its cutoff
 * turn through lineage. Handoffs and spawned subagents inherit nothing.
 *
 * Storage keeps one row per key per turn, so a source's later repeat never
 * rewrites what a fork saw before its cutoff; readers dedupe only the rows
 * their lineage makes eligible.
 */
import type { ShownLink as CorrespondenceShownLink } from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { SpelledLinkFact } from "@meridian/markup/links";

/** One recorded showing; `at` is its global sequence, larger is more recent. */
export interface ShownLink extends CorrespondenceShownLink {
  /** `live` or `draft:<workId>`. */
  view: string;
}

/** What one result showed the model in one holder document. */
export interface ShownLinkShowing {
  documentId: string;
  holderUri: string;
  /** The view the links were actually spelled in. */
  view: LinkView;
  links: readonly SpelledLinkFact[];
}

export interface RecordShownLinksInput extends ShownLinkShowing {
  threadId: string;
  turnId: string;
}

export interface ShownLinkStore {
  /**
   * Upsert per key and turn, keeping the greatest sequence when concurrent
   * writers race. Joins an ambient transaction if any.
   */
  record(input: RecordShownLinksInput): Promise<void>;
  /** Own rows plus, for a fork, the source thread's rows at turns up to its cutoff, recursively. */
  forDocument(threadId: string, documentId: string): Promise<ShownLink[]>;
}

export function linkViewKey(view: LinkView): string {
  return view.kind === "draft" ? `draft:${view.workId}` : "live";
}

/** One thread whose rows a reader sees; `maxPosition` caps an inherited source by turn position. */
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

/**
 * The threads whose showings `threadId` reads: itself uncapped, then each fork
 * source capped at the tightest cutoff position on the way. Fork turns number
 * on from their cutoff, so one position cap holds across the whole chain.
 */
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

/** Keeps the latest showing per key across the lineage's eligible rows. */
export function latestShowings(rows: readonly ShownLink[]): ShownLink[] {
  const latest = new Map<string, ShownLink>();
  for (const row of rows) {
    const key = JSON.stringify([row.ref, row.address, row.holderUri, row.view]);
    const existing = latest.get(key);
    if (!existing || existing.at < row.at) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}
