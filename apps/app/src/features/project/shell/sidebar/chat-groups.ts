import type { ThreadListItem } from "@meridian/contracts/protocol";

export type RowState = "needs-you" | "running" | "idle";

export type ChatGroups = {
  pinned: ThreadListItem[];
  scoped: ThreadListItem[];
  othersPinned: ThreadListItem[];
  others: ThreadListItem[];
  othersState: RowState;
  helpers: Map<string, ThreadListItem[]>;
  states: Map<string, RowState>;
  replying: Set<string>;
};

const URGENCY: Record<RowState, number> = { "needs-you": 0, running: 1, idle: 2 };

export function groupChats(
  threads: readonly ThreadListItem[],
  scopeWorkId: string | null,
  noWorkId: string | null,
  pinnedIds: ReadonlySet<string>,
): ChatGroups {
  const inScope = (thread: ThreadListItem) => (thread.workId ?? noWorkId) === scopeWorkId;
  const helpers = new Map<string, ThreadListItem[]>();
  for (const thread of threads) {
    if (thread.kind !== "subagent" || thread.spawnStatus !== "running" || !thread.parentThreadId)
      continue;
    const list = helpers.get(thread.parentThreadId) ?? [];
    list.push(thread);
    helpers.set(thread.parentThreadId, list);
  }
  const recent = threads
    .filter((thread) => thread.kind === "primary")
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const states = new Map<string, RowState>();
  const replying = new Set<string>();
  const pinned: ThreadListItem[] = [];
  const scoped: ThreadListItem[] = [];
  const others: ThreadListItem[] = [];
  const othersPinned: ThreadListItem[] = [];
  let othersState: RowState = "idle";
  for (const thread of recent) {
    const busy = thread.runningTurnId !== null;
    if (busy) replying.add(thread.id);
    const state: RowState = thread.actionRequired ? "needs-you" : busy ? "running" : "idle";
    states.set(thread.id, state);
    const pin = pinnedIds.has(thread.id);
    if (inScope(thread)) (pin ? pinned : scoped).push(thread);
    else {
      (pin ? othersPinned : others).push(thread);
      if (URGENCY[state] < URGENCY[othersState]) othersState = state;
    }
  }
  const byUrgency = (a: ThreadListItem, b: ThreadListItem) =>
    URGENCY[states.get(a.id) ?? "idle"] - URGENCY[states.get(b.id) ?? "idle"];
  return {
    pinned: pinned.sort(byUrgency),
    scoped: scoped.sort(byUrgency),
    othersPinned: othersPinned.sort(byUrgency),
    others,
    othersState,
    helpers,
    states,
    replying,
  };
}
