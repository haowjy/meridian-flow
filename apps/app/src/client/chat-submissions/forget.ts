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

export type ForgetChatResult = "forgotten" | "creation" | "unavailable" | "stale";

export async function forgetCreatedChatCopies(
  owner: ChatCopyOwner,
  threadId: string,
): Promise<ForgetChatResult> {
  return owner.lock.run(owner.accountId, threadId, owner.signal, async () => {
    if (!owner.current()) return "stale";
    if (owner.created?.(threadId) === false) return "creation";
    const entries = owner.entries();
    if (!entries) return "unavailable";
    const cohort = entries.filter((entry) => entry.threadId === threadId);
    // A first-send 404 belongs to O4's transfer, not deletion.
    if (cohort.some((entry) => entry.creation)) return "creation";
    for (const entry of cohort) owner.retire(entry.recordId);
    owner.forgetDraft(threadId);
    return "forgotten";
  });
}

/** One pass per bind. Unique journal destinations only; no storage-wide or periodic sweep. */
export async function reconcileChatCopies(
  owner: ChatCopyOwner,
  mounted: (threadId: string) => boolean,
  probe: (
    threadId: string,
    submissionId: string,
  ) => Promise<import("./thread-availability").ThreadAvailability | "present" | "unknown">,
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
          const record = entries.find((entry) => entry.threadId === id);
          if (record) {
            const availability = await probe(id, record.submissionId);
            if (["deleted", "project-deleted"].includes(availability) && owner.current())
              await forgetCreatedChatCopies(owner, id);
          }
        } catch {
          // Transport, timeout and non-definitive responses preserve the copies.
        }
      }
    }),
  );
}
