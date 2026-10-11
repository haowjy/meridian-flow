/** Confirmed disappearance policy, shared by commands, route repair and reconciliation. */
import type { SubmissionLock } from "./lock";
import type { ChatSubmission } from "./store";

export type ChatCopyOwner = {
  accountId: string;
  signal: AbortSignal;
  current(): boolean;
  /** Mounted owners retain creation provenance after a sibling retires the cohort. */
  created?(threadId: string): boolean;
  lock: SubmissionLock;
  entries(): ChatSubmission[] | null;
  retire(recordId: string): void;
  forgetDraft(threadId: string): void;
};

export async function forgetCreatedChatCopies(
  owner: ChatCopyOwner,
  threadId: string,
): Promise<boolean> {
  return owner.lock.run(owner.accountId, threadId, owner.signal, async () => {
    if (!owner.current() || owner.created?.(threadId) === false) return false;
    const entries = owner.entries();
    if (!entries) return false;
    const cohort = entries.filter((entry) => entry.threadId === threadId);
    // A first-send 404 belongs to O4's transfer, not deletion.
    if (cohort.some((entry) => entry.creation)) return false;
    for (const entry of cohort) owner.retire(entry.recordId);
    owner.forgetDraft(threadId);
    return true;
  });
}

/** One pass per bind. Unique journal destinations only; no storage-wide or periodic sweep. */
export async function reconcileChatCopies(
  owner: ChatCopyOwner,
  mounted: (threadId: string) => boolean,
  probe: (threadId: string) => Promise<"missing" | "unknown">,
): Promise<void> {
  const entries = owner.entries() ?? [];
  const ids = [...new Set(entries.map((entry) => entry.threadId))].filter(
    (id) => !mounted(id) && !entries.some((entry) => entry.threadId === id && entry.creation),
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (owner.current()) {
        const id = ids[next++];
        if (!id) return;
        if (mounted(id)) continue;
        try {
          if ((await probe(id)) === "missing" && owner.current())
            await forgetCreatedChatCopies(owner, id);
        } catch {
          // Transport, timeout and non-definitive responses preserve the copies.
        }
      }
    }),
  );
}
