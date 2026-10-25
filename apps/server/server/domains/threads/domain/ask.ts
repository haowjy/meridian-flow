/** Durable ask serialization and model-result rendering. */

import type { JsonObject, ThreadAsk } from "@meridian/contracts/threads";
import type { StoredAsk } from "../ports/ask-repository.js";

export function threadAsk(ask: StoredAsk): ThreadAsk {
  return {
    id: ask.id,
    threadId: ask.threadId,
    turnId: ask.askingTurnId,
    toolCallId: ask.toolCallId,
    kind: ask.kind,
    payload: ask.payload,
    deadlineAt: ask.deadlineAt?.toISOString() ?? null,
    status: ask.status,
    resolution: ask.resolution,
    createdAt: ask.createdAt.toISOString(),
    resolvedAt: ask.resolvedAt?.toISOString() ?? null,
  } as ThreadAsk;
}

export function askToolResult(ask: Pick<StoredAsk, "resolution">): JsonObject {
  const resolution = ask.resolution;
  if (!resolution) throw new Error("Resolved ask has no resolution");
  switch (resolution.kind) {
    case "option":
      return { answer: resolution.label };
    case "text":
      return { answer: resolution.text, free_text: true };
    case "skipped":
      return { answer: null, skipped: true };
    case "timeout":
      return { answer: resolution.label, timed_out: true };
    case "cancelled":
      return { cancelled: true };
    case "parent":
      return { answer: resolution.text, from: "@parent" };
    case "allow":
    case "allow_always":
    case "deny":
      throw new Error("Permission ask results are owned by the permission lifecycle");
  }
}
