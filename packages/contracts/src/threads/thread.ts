import { z } from "zod";
import { reasoningLevelSchema } from "../agents/execution-knobs.js";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";

export const threadOverridesSchema = z.strictObject({
  model: z.string().min(1).nullable(),
  effort: reasoningLevelSchema.nullable(),
});
export type ThreadOverrides = z.infer<typeof threadOverridesSchema>;
export const NO_OVERRIDES: ThreadOverrides = { model: null, effort: null };

export const threadSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  workId: z.string().nullable(),
  aiWriteMode: aiWriteModeSchema,
  effectiveAiWriteMode: aiWriteModeSchema,
  userId: z.string().min(1),
  kind: z.enum(["primary", "subagent"]),
  title: z.string().nullable(),
  ref: z.string().nullable(),
  initialPromptBakeId: z.string().nullable(),
  agentDefinitionRevisionId: z.string().nullable(),
  agentName: z.string().nullable(),
  overrides: threadOverridesSchema,
  nextSeq: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .optional(),
  activeLeafTurnId: z.string().nullable(),
  parentThreadId: z.string().nullable(),
  originType: z.enum(["spawn", "handoff", "fork"]).nullable().optional(),
  originTurnId: z.string().nullable().optional(),
  rootThreadId: z.string().min(1),
  draftId: z.string().min(1),
  spawnDepth: z.number().int().nonnegative(),
  spawnStatus: z.enum(["running", "succeeded", "failed", "cancelled"]).nullable(),
  totalCostUsd: z.string(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  deletedAt: z.string().nullable(),
});

export type Thread = z.infer<typeof threadSchema>;
