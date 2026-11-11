import type { ThreadListItem } from "@meridian/contracts/protocol";

/** Idle chats shown before "All chats" takes over. */
const IDLE_SHOWN = 6;

export type RowState = "needs-you" | "running" | "idle";

export type ChatGroups = {
  needsYou: ThreadListItem[];
  running: ThreadListItem[];
  idle: ThreadListItem[];
  helpers: Map<string, ThreadListItem[]>;
  otherWorks: { workId: string; running: number; needsYou: number }[];
  /** Every chat's state, for a row in any list: Favourites, All chats, find results. */
  states: Map<string, RowState>;
  /** The chats with a reply running: deleting one stops it. */
  replying: Set<string>;
};

/**
 * The scoped Work's chats by what they need from the writer, the working helpers under their
 * parent, and one count per other Work while one of its chats needs the writer or is running.
 */
export function groupChats(
  threads: readonly ThreadListItem[],
  scopeWorkId: string | null,
  noWorkId: string | null,
  currentThreadId: string | null,
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
    needsYou,
    running,
    idle: idle.slice(0, IDLE_SHOWN),
    helpers,
    otherWorks: [...others.values()],
    states,
    replying,
  };
}
