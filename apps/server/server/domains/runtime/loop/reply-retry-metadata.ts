/** Internal provenance that lets Retry replay a failed reply's original inbox inputs. */
import type { JsonValue, Turn } from "@meridian/contracts/threads";

export type ReplyRetryMetadata = {
  messageIds: string[];
  retryOfTurnId?: string;
};

export function readReplyRetryMetadata(turn: Pick<Turn, "metadata">): ReplyRetryMetadata | null {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata.replyRetry;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const retry = value as Record<string, unknown>;
  if (!Array.isArray(retry.messageIds) || !retry.messageIds.every((id) => typeof id === "string"))
    return null;
  return {
    messageIds: retry.messageIds,
    ...(typeof retry.retryOfTurnId === "string" ? { retryOfTurnId: retry.retryOfTurnId } : {}),
  };
}

export function markFailedReplyRetryable(
  metadata: JsonValue | null | undefined,
  messageIds: readonly string[],
): JsonValue {
  const current =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, JsonValue>)
      : {};
  const previous =
    current.replyRetry &&
    typeof current.replyRetry === "object" &&
    !Array.isArray(current.replyRetry)
      ? (current.replyRetry as Record<string, JsonValue>)
      : {};
  return {
    ...current,
    replyRetry: {
      ...previous,
      messageIds: [...new Set(messageIds)],
    },
  };
}

export function markReplyRetryOrigin(
  metadata: JsonValue | null | undefined,
  retryOfTurnId: string,
): JsonValue {
  const current =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, JsonValue>)
      : {};
  return {
    ...current,
    replyRetry: {
      retryOfTurnId,
      messageIds: [],
    },
  };
}
