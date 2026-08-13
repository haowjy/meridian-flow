/** Canonical visible-conversational-head and effective-attention policy. */
import type {
  JsonValue,
  ThreadAttention,
  ThreadStatus,
  TurnRole,
  TurnStatus,
} from "@meridian/contracts/threads";

export function isVisibleConversationalTurn(input: {
  role: TurnRole;
  metadata: JsonValue | null;
  hasCustomBlock: boolean;
}): boolean {
  if (input.role === "assistant") return true;
  if (input.role === "system") return input.hasCustomBlock;
  if (input.role !== "user") return false;
  const metadata = input.metadata as Record<string, unknown> | null;
  return !(metadata?.kind === "system_update" && metadata.section === "work_context");
}

export function projectEffectiveThreadAttention(input: {
  threadStatus: ThreadStatus;
  headRole: TurnRole | null;
  headStatus: TurnStatus | null;
  headActivityAt: string | null;
  lastOpenedAt: string | null;
  manuallyUnread: boolean;
}): ThreadAttention {
  if (input.headRole === "assistant" && input.headStatus === "waiting_interrupt")
    return "actionRequired";
  if (input.manuallyUnread) return "unread";
  if (
    input.threadStatus === "idle" &&
    input.headRole === "assistant" &&
    input.headStatus === "complete" &&
    input.headActivityAt !== null &&
    (input.lastOpenedAt === null || input.lastOpenedAt < input.headActivityAt)
  )
    return "unread";
  return "none";
}
