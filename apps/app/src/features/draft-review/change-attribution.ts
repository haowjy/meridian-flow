/**
 * Who made a change, as the writer reads it: "You", the chats they can open,
 * or plain "AI" when the preview cannot say which chat.
 *
 * The chats come from the visible operations of the class (`actorThreadId`,
 * `actorThreadTitle`), latest first. A class can hold several chats' operations
 * (two turns that edited the same spot, or edits closure tied together), and
 * each chat is named once, with the turn and tool call of its own latest
 * operation (`actorTurnId`, `actorToolCallId`), which say where in that chat the
 * write happened and are absent for writes that predate them. A physical row
 * that supplies text to the class but is not an operation of it names no chat.
 * An operation the server cannot place in a chat reads "AI".
 */
import type { ReviewOperation } from "@meridian/contracts/drafts";

/** One chat that wrote into a change, and where in it the write happened. */
export interface ChangeChat {
  threadId: string;
  title: string | null;
  /** The turn that wrote it, when the server recorded one. */
  turnId: string | null;
  /** The tool call in that turn that wrote it, when the server recorded one. */
  toolCallId: string | null;
}

export type ChangeAttribution =
  | { kind: "you" }
  /** One or more chats, the one whose write came last first. */
  | { kind: "chats"; chats: [ChangeChat, ...ChangeChat[]] }
  | { kind: "ai" }
  /** A difference the server could not attribute to anyone. Never given an invented author. */
  | { kind: "unattributed" };

export function changeAttribution(operations: readonly ReviewOperation[]): ChangeAttribution {
  const agentOps = operations.filter((op) => op.kind === "agent");
  if (agentOps.length === 0) return { kind: "you" };
  // Operation ids are increasing integers in journal order; the highest is the latest.
  const latestFirst = [...agentOps].sort(
    (a, b) =>
      Number(b.operationId) - Number(a.operationId) || b.operationId.localeCompare(a.operationId),
  );
  // Walking latest first, a chat's first operation is its latest one, and the
  // order chats are met in is the order they are named in.
  const chats = new Map<string, ChangeChat>();
  for (const op of latestFirst) {
    if (!op.actorThreadId || chats.has(op.actorThreadId)) continue;
    chats.set(op.actorThreadId, {
      threadId: op.actorThreadId,
      title: op.actorThreadTitle?.trim() || null,
      turnId: op.actorTurnId ?? null,
      toolCallId: op.actorToolCallId ?? null,
    });
  }
  const [first, ...rest] = chats.values();
  return first ? { kind: "chats", chats: [first, ...rest] } : { kind: "ai" };
}

/** The ids of the chats a change names: the strip filters on them. */
export function attributionThreadIds(attribution: ChangeAttribution): string[] {
  return attribution.kind === "chats" ? attribution.chats.map((chat) => chat.threadId) : [];
}
