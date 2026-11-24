import type { Thread, Work } from "@meridian/contracts/protocol";

export type ChatScratchOwner =
  | { kind: "work"; workId: string }
  | { kind: "lineage"; rootThreadId: string };

export function chatScratchOwner(input: {
  thread: Pick<Thread, "rootThreadId"> | null | undefined;
  work: Pick<Work, "id" | "isNoWork"> | null | undefined;
}): ChatScratchOwner | null {
  const { thread, work } = input;
  if (!work) return null;
  if (!work.isNoWork) return { kind: "work", workId: work.id };
  return thread ? { kind: "lineage", rootThreadId: thread.rootThreadId } : null;
}

export function chatLineageId(input: Parameters<typeof chatScratchOwner>[0]): string | null {
  const owner = chatScratchOwner(input);
  return owner?.kind === "lineage" ? owner.rootThreadId : null;
}
