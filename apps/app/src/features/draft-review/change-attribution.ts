/**
 * Who made a change, as the writer reads it: "You", a chat they can open, or
 * plain "AI" when the preview cannot say which chat.
 *
 * The chat comes from the operation's thread (`actorThreadId`,
 * `actorThreadTitle`). A class can hold several chats' operations (two turns
 * that edited the same spot); it links to the latest, the one whose text won.
 * Until the preview carries the thread, every AI change reads "AI".
 */
import type { ReviewOperation } from "@meridian/contracts/drafts";

/** The additive preview fields attribution reads; absent until the server supplies them. */
type ThreadAttributed = ReviewOperation & {
  actorThreadId?: string | null;
  actorThreadTitle?: string | null;
};

export type ChangeAttribution =
  | { kind: "you" }
  | { kind: "chat"; threadId: string; title: string | null }
  | { kind: "ai" };

export function changeAttribution(operations: readonly ReviewOperation[]): ChangeAttribution {
  const agentOps = operations.filter((op): op is ThreadAttributed => op.kind === "agent");
  if (agentOps.length === 0) return { kind: "you" };
  // Operation ids are increasing integers in journal order; the highest is the latest.
  const latest = [...agentOps].sort(
    (a, b) =>
      Number(b.operationId) - Number(a.operationId) || b.operationId.localeCompare(a.operationId),
  );
  const threaded = latest.find((op) => op.actorThreadId);
  if (!threaded?.actorThreadId) return { kind: "ai" };
  return {
    kind: "chat",
    threadId: threaded.actorThreadId,
    title: threaded.actorThreadTitle ?? null,
  };
}
