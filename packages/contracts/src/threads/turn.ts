import { z } from "zod";
import { aiWriteModeSchema } from "../works/ai-write-mode.js";
import {
  prefixCachePredictionReasonSchema,
  prefixCachePredictionStateSchema,
} from "./prefix-cache-prediction.js";
import { turnStatusSchema } from "./status.js";

export const turnRoleSchema = z.enum(["user", "assistant", "system", "compaction"]);
export const turnOriginSchema = z.enum(["writer", "assistant", "system"]);
export const blockTypeSchema = z.enum([
  "text",
  "media",
  "reasoning",
  "thinking",
  "tool_use",
  "tool_result",
  "custom",
]);
export const blockStatusSchema = z.enum(["complete", "partial"]);
export const executionSideSchema = z.enum(["server", "client", "hosted"]);
export const finishReasonSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "error",
]);
export const priceSourceSchema = z.enum(["computed", "unknown"]);

export const turnDeliverySchema = z.object({ byTurnId: z.string().nullable() });
export type TurnDelivery = z.infer<typeof turnDeliverySchema>;

export const blockSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  responseId: z.string().nullable(),
  blockType: blockTypeSchema,
  sequence: z.number(),
  textContent: z.string().nullable().optional(),
  content: z.json(),
  modelText: z.string().optional(),
  compact: z.string().optional(),
  provider: z.string().nullable().optional(),
  providerData: z.json().nullable().optional(),
  executionSide: executionSideSchema.nullable().optional(),
  status: blockStatusSchema.optional(),
  collapsedContent: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type Block = z.infer<typeof blockSchema>;

export const modelResponseSchema = z.object({
  id: z.string(),
  turnId: z.string(),
  sequence: z.number(),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  cacheReset: z.boolean(),
  usageBreakdown: z.json().nullable().optional(),
  costUsd: z.string().nullable(),
  millicredits: z.string().nullable().optional(),
  priceSource: priceSourceSchema.optional(),
  pricingSnapshot: z.json().nullable().optional(),
  finishReason: finishReasonSchema.nullable().optional(),
  stopReason: z.string().nullable().optional(),
  requestParams: z.json().nullable().optional(),
  responseMetadata: z.json().nullable().optional(),
  latencyMs: z.number().nullable(),
  requestMessageCount: z.number(),
  requestStartedAt: z.string().nullable(),
  timeToFirstTokenMs: z.number().nullable(),
  generationMs: z.number().nullable(),
  rawUsage: z.json().nullable().optional(),
  predictedCacheState: prefixCachePredictionStateSchema,
  predictedCacheReason: prefixCachePredictionReasonSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export const turnUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  totalCostUsd: z.string(),
  totalMillicredits: z.string().optional(),
  responseCount: z.number(),
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;

export const turnSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  position: z.number(),
  prevTurnId: z.string().nullable().optional(),
  parentTurnId: z.string().nullable().optional(),
  role: turnRoleSchema,
  origin: turnOriginSchema,
  writeMode: aiWriteModeSchema.nullable(),
  status: turnStatusSchema,
  executionId: z.string().nullable(),
  reservedForUserTurnIds: z.array(z.string()),
  delivery: turnDeliverySchema.nullable(),
  forgottenBy: z.string().nullable(),
  promptBakeId: z.string().nullable(),
  compactionModel: z.string().nullable().optional(),
  finishReason: finishReasonSchema.nullable(),
  model: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  totalCostUsd: z.string(),
  totalMillicredits: z.string().optional(),
  responseCount: z.number(),
  usage: turnUsageSchema.nullable(),
  error: z.string().nullable(),
  requestParams: z.json().nullable().optional(),
  responseMetadata: z.json().nullable().optional(),
  metadata: z.json().nullable().optional(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  blocks: z.array(blockSchema),
  siblingIds: z.array(z.string()),
  responses: z.array(modelResponseSchema),
});
export type Turn = z.infer<typeof turnSchema>;
