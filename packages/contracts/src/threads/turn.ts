/** Canonical snapshot turn, block, usage and model-response wire schemas. */
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
  "image",
  "file",
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
export const priceSourceSchema = z.enum([
  "computed",
  "provider_reported",
  "configured_rate",
  "unknown",
]);

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
  providerRequestId: z.string().nullable().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  /** True when this call's reported cache read dropped below half the previous prompt after prior cache activity. */
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
  /** Adapter invocation to provider stream-end arrival; excludes consumer persistence time. */
  latencyMs: z.number().nullable(),
  /** Wall-clock start of the successful provider attempt; null means unknown. */
  requestMessageCount: z.number(),
  requestStartedAt: z.string().nullable(),
  /** Adapter invocation to first text, reasoning, or tool-argument delta arrival; null if none. */
  timeToFirstTokenMs: z.number().nullable(),
  /** First output arrival to provider stream-end arrival; null if no output delta arrived. */
  generationMs: z.number().nullable(),
  rawUsage: z.json().nullable().optional(),
  predictedCacheState: prefixCachePredictionStateSchema,
  predictedCacheReason: prefixCachePredictionReasonSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type ModelResponse = z.infer<typeof modelResponseSchema>;

export const turnUsageSchema = z.object({
  /** Provider-normalized prompt total, including cache-read and cache-write token subsets. */
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
  /** Write-once insertion order within its thread, assigned by persistence. */
  position: z.number(),
  prevTurnId: z.string().nullable().optional(),
  parentTurnId: z.string().nullable().optional(),
  role: turnRoleSchema,
  /** Who authored this turn; see {@link TurnOrigin}. */
  origin: turnOriginSchema,
  /** Write policy frozen when this turn began; null identifies pre-contract turns. */
  writeMode: aiWriteModeSchema.nullable(),
  status: turnStatusSchema,
  /**
   * The execution (one run-lease hold) that reserved this turn. Null on turns no
   * execution reserves (user, switch, notice, handoff seed) and on turns
   * reserved before run identity.
   */
  executionId: z.string().nullable(),
  /**
   * The messages (= user turn ids) this turn was reserved to handle; a Retry
   * carries its failed reply's. A binding and Stop hint, never proof of delivery.
   */
  reservedForUserTurnIds: z.array(z.string()),
  /**
   * On a user turn whose inbox message was delivered: the delivering turn, or
   * null when unknown (delivered before run identity, or by no reserved turn).
   * Null while undelivered and on every other turn.
   */
  delivery: turnDeliverySchema.nullable(),
  /**
   * The turn that retried this failed attempt or moved the chat past it; write-once. A forgotten turn
   * stays in the graph but has left the conversation. Null on every turn the chat still holds, and on
   * local and optimistic turns. A reader applies it only when the forgetting turn is inside the span it reads.
   */
  forgottenBy: z.string().nullable(),
  /** Set once on a completed prompt-epoch boundary. */
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
