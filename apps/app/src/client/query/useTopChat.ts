/**
 * The chat that owns a thread's uploads: a primary thread is its own chat, and a subagent
 * uses its top primary's. A fork or handoff is a primary thread, so it owns its own.
 */
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { useProjectThreads } from "./useProjectThreads";

export type TopChat = { chatId: string; chatRef: string | null };

type ChatThread = Pick<ThreadListItem, "id" | "ref" | "kind" | "parentThreadId">;

export function topChatOf(
  thread: ChatThread | null | undefined,
  threads: readonly ChatThread[] | null | undefined,
): TopChat | null {
  let current = thread ?? null;
  for (let hops = 0; current && hops < 32; hops += 1) {
    if (current.kind !== "subagent" || !current.parentThreadId)
      return { chatId: current.id, chatRef: current.ref ?? null };
    const parentId: string = current.parentThreadId;
    current = threads?.find((candidate) => candidate.id === parentId) ?? null;
  }
  return null;
}

/** Null until the thread, and for a subagent its ancestors, are in the project's thread list. */
export function useTopChat(
  projectId: string | null,
  thread: ChatThread | null | undefined,
): TopChat | null {
  const { threads } = useProjectThreads(projectId ?? "", { enabled: Boolean(projectId && thread) });
  return topChatOf(thread, threads);
}
