/** Snapshot read boundary shared by the app and CLI, before either invokes ThreadSync. */
import { z } from "zod";
import { threadSchema } from "../threads/thread.js";
import { turnSchema } from "../threads/turn.js";
import { threadLiveStateSchema } from "./ws-protocol.js";

export const threadSnapshotSchema = z.object({
  threadId: z.string(),
  thread: threadSchema,
  turns: z.array(turnSchema),
  liveState: threadLiveStateSchema.extend({
    /** The last frame materialized by this snapshot; joins resume strictly after it. */
    resumeAfterSeq: z.string().regex(/^(0|[1-9]\d*)$/),
  }),
  nextSeq: z.string().regex(/^(0|[1-9]\d*)$/),
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
    z.object({ id: z.string(), title: z.string().nullable(), agentName: z.string().nullable() }),
  ),
});

export type ThreadSnapshotResponse = z.infer<typeof threadSnapshotSchema>;
export type ThreadSnapshotAncestor = ThreadSnapshotResponse["ancestors"][number];
