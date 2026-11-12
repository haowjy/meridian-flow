import type { ThreadListItem } from "@meridian/contracts/protocol";

export type RowState = "needs-you" | "running" | "idle";

export type ChatGroups = {
  /** Every pinned chat, from any Work, most urgent first. Listed nowhere else. */
  pinned: ThreadListItem[];
  /** The scoped Work's unpinned chats, most urgent first. */
  scoped: ThreadListItem[];
  /** Every other unpinned chat, newest first. */
  others: ThreadListItem[];
  /** The most urgent state among `others`, for its heading while folded. */
  othersState: RowState;
  helpers: Map<string, ThreadListItem[]>;
  /** Every chat's state, for a row in any list: the lists, find results. */
  states: Map<string, RowState>;
  /** The chats with a reply running: deleting one stops it. */
  replying: Set<string>;
};

const URGENCY: Record<RowState, number> = { "needs-you": 0, running: 1, idle: 2 };

/**
 * Each chat once: pinned, else the scoped Work's (the open chat counts as the Work's), else
 * the others; the working helpers under their parent.
 */
export function groupChats(
  threads: readonly ThreadListItem[],
  scopeWorkId: string | null,
  noWorkId: string | null,
  currentThreadId: string | null,
  pinnedIds: ReadonlySet<string>,
): ChatGroups {
  const inScope = (thread: ThreadListItem) =>
    (thread.workId ?? noWorkId) === scopeWorkId || thread.id === currentThreadId;
  const helpers = new Map<string, ThreadListItem[]>();
  for (const thread of threads) {
    if (thread.kind !== "subagent" || thread.spawnStatus !== "running" || !thread.parentThreadId)
      continue;
    const list = helpers.get(thread.parentThreadId) ?? [];
    list.push(thread);
    helpers.set(thread.parentThreadId, list);
  }
  const recent = threads
    .filter((thread) => thread.kind === "primary" && thread.status !== "archived")
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const states = new Map<string, RowState>();
  const replying = new Set<string>();
  const pinned: ThreadListItem[] = [];
  const scoped: ThreadListItem[] = [];
  const others: ThreadListItem[] = [];
  let othersState: RowState = "idle";
  for (const thread of recent) {
    const busy = thread.runningTurnId !== null;
    if (busy) replying.add(thread.id);
    const state: RowState = thread.actionRequired ? "needs-you" : busy ? "running" : "idle";
    states.set(thread.id, state);
    if (pinnedIds.has(thread.id)) pinned.push(thread);
    else if (inScope(thread)) scoped.push(thread);
    else {
      others.push(thread);
      if (URGENCY[state] < URGENCY[othersState]) othersState = state;
    }
  }
  const byUrgency = (a: ThreadListItem, b: ThreadListItem) =>
    URGENCY[states.get(a.id) ?? "idle"] - URGENCY[states.get(b.id) ?? "idle"];
  return {
    pinned: pinned.sort(byUrgency),
    scoped: scoped.sort(byUrgency),
    others,
    othersState,
    helpers,
    states,
    replying,
  };
}
