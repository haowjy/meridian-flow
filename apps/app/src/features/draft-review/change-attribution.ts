/**
 * Who made a change, as the writer reads it: "You", a chat they can open, or
 * plain "AI" when the preview cannot say which chat.
 *
 * The chat comes from the operation's thread (`actorThreadId`,
 * `actorThreadTitle`). A class can hold several chats' operations (two turns
 * that edited the same spot); it links to the latest, the one whose text won.
 * An operation the server cannot place in a chat reads "AI".
 */
import type { ReviewOperation } from "@meridian/contracts/drafts";

export type ChangeAttribution =
  | { kind: "you" }
  | { kind: "chat"; threadId: string; title: string | null }
  | { kind: "ai" }
  /** A difference the server could not attribute to anyone. Never given an invented author. */
  | { kind: "unattributed" };

export function changeAttribution(operations: readonly ReviewOperation[]): ChangeAttribution {
  const agentOps = operations.filter((op) => op.kind === "agent");
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
    title: threaded.actorThreadTitle?.trim() || null,
  };
}
