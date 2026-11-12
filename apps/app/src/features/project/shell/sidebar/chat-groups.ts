import type { ThreadListItem } from "@meridian/contracts/protocol";

/** Idle chats shown before "All chats" takes over. */
const IDLE_SHOWN = 6;

export type RowState = "needs-you" | "running" | "idle";

export type ChatGroups = {
  /** Every pinned chat, from any Work, most urgent first. Listed nowhere else. */
  pinned: ThreadListItem[];
  /** The most urgent state among the pinned chats, for Pinned's heading while folded. */
  pinnedState: RowState;
  needsYou: ThreadListItem[];
  running: ThreadListItem[];
  idle: ThreadListItem[];
  helpers: Map<string, ThreadListItem[]>;
  otherWorks: { workId: string; running: number; needsYou: number }[];
  /** Every chat's state, for a row in any list: Pinned, All chats, find results. */
  states: Map<string, RowState>;
  /** The chats with a reply running: deleting one stops it. */
  replying: Set<string>;
};

/**
 * The pinned chats, then the scoped Work's other chats, each by what they need from the writer;
 * the working helpers under their parent; and one count per other Work while one of its unpinned
 * chats needs the writer or is running. Pinned chats never take a place in the idle cap.
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
  const pinned: Record<RowState, ThreadListItem[]> = { "needs-you": [], running: [], idle: [] };
  const needsYou: ThreadListItem[] = [];
  const running: ThreadListItem[] = [];
  const idle: ThreadListItem[] = [];
  const states = new Map<string, RowState>();
  const replying = new Set<string>();
  const others = new Map<string, { workId: string; running: number; needsYou: number }>();
  for (const thread of recent) {
    const busy = thread.runningTurnId !== null;
    if (busy) replying.add(thread.id);
    const state: RowState = thread.actionRequired ? "needs-you" : busy ? "running" : "idle";
    states.set(thread.id, state);
    if (pinnedIds.has(thread.id)) {
      pinned[state].push(thread);
      continue;
    }
    if (!inScope(thread)) {
      if (state === "idle") continue;
      const workId = thread.workId ?? noWorkId;
      if (!workId) continue;
      const other = others.get(workId) ?? { workId, running: 0, needsYou: 0 };
      if (state === "needs-you") other.needsYou += 1;
      else other.running += 1;
      others.set(workId, other);
      continue;
    }
    if (state === "needs-you") needsYou.push(thread);
    else if (state === "running") running.push(thread);
    else idle.push(thread);
  }
  return {
    pinned: [...pinned["needs-you"], ...pinned.running, ...pinned.idle],
    pinnedState: pinned["needs-you"].length
      ? "needs-you"
      : pinned.running.length
        ? "running"
        : "idle",
    needsYou,
    running,
    idle: idle.slice(0, IDLE_SHOWN),
    helpers,
    otherWorks: [...others.values()],
    states,
    replying,
  };
}
