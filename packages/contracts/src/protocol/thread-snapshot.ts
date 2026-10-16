/** Snapshot read boundary shared by the app and CLI, before either invokes ThreadSync. */
import { z } from "zod";
import type { ThreadSnapshotResponse } from "./http-types.js";
import { threadLiveStateSchema } from "./ws-protocol.js";

const seq = z.string().regex(/^(0|[1-9]\d*)$/);
const nullableString = z.string().nullable();
const block = z.looseObject({
  id: z.string(),
  turnId: z.string(),
  blockType: z.enum([
    "text",
    "image",
    "file",
    "reasoning",
    "thinking",
    "tool_use",
    "tool_result",
    "custom",
  ]),
  sequence: z.number(),
  textContent: nullableString.optional(),
  content: z.json(),
});
const turn = z.looseObject({
  id: z.string(),
  threadId: z.string(),
  position: z.number(),
  prevTurnId: nullableString.optional(),
  parentTurnId: nullableString.optional(),
  role: z.enum(["user", "assistant", "system", "compaction"]),
  origin: z.enum(["writer", "assistant", "system"]),
  status: z.enum(["pending", "streaming", "waiting_interrupt", "complete", "cancelled", "error"]),
  executionId: nullableString,
  reservedForUserTurnIds: z.array(z.string()),
  delivery: z.object({ byTurnId: nullableString }).nullable(),
  forgottenBy: nullableString,
  blocks: z.array(block),
  siblingIds: z.array(z.string()),
  responses: z.array(z.looseObject({ id: z.string() })),
  metadata: z.json().optional(),
});
const snapshot = z.looseObject({
  threadId: z.string(),
  thread: z.looseObject({
    id: z.string(),
    userId: z.string(),
    projectId: z.string(),
    workId: nullableString,
    activeLeafTurnId: nullableString,
  }),
  turns: z.array(turn),
  liveState: threadLiveStateSchema,
  nextSeq: seq,
  actionRequired: z.boolean(),
  threadUsage: z.object({
    inputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheReportedInputTokens: z.number(),
    cacheReportedCalls: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    cacheResets: z.number(),
  }),
  ancestors: z.array(
    z.object({ id: z.string(), title: nullableString, agentName: nullableString }),
  ),
});

// Validate the structural inputs consumed by sync and its claims, not every presentation field.
// Keep the original DTO whole: parsing a subset must not strip fields needed by other readers.
export const threadSnapshotSchema = z.custom<ThreadSnapshotResponse>(
  (value) => snapshot.safeParse(value).success,
  "Invalid thread snapshot response",
);
