/**
 * A chat's Scratch owner: its named Work, or its lineage when it is on No Work.
 *
 * The one rule behind a bare `scratch://` in a chat, the chat's `@` picker
 * and link scope, and the rail's Scratch section. A lineage is the first chat
 * and every fork and subagent sharing its `rootThreadId`; a handoff starts its own.
 */
import type { Thread, Work } from "@meridian/contracts/protocol";

export type ChatScratchOwner =
  | { kind: "work"; workId: string }
  | { kind: "lineage"; rootThreadId: string };

/** Null while the chat's Work or the chat itself is not known yet. */
export function chatScratchOwner(input: {
  thread: Pick<Thread, "rootThreadId"> | null | undefined;
  work: Pick<Work, "id" | "isNoWork"> | null | undefined;
}): ChatScratchOwner | null {
  const { thread, work } = input;
  if (!work) return null;
  if (!work.isNoWork) return { kind: "work", workId: work.id };
  return thread ? { kind: "lineage", rootThreadId: thread.rootThreadId } : null;
}

/** The lineage a chat's bare `scratch://` means, or null when it is on a named Work. */
export function chatLineageId(input: Parameters<typeof chatScratchOwner>[0]): string | null {
  const owner = chatScratchOwner(input);
  return owner?.kind === "lineage" ? owner.rootThreadId : null;
}
