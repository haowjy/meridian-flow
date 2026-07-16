/**
 * Purpose: Defines the produced orchestrator event payload union persisted in event_journal.payload and replayed to live projections.
 * Why independent: Durable thread events are a shared contract between the orchestrator, event journal, thread event hub, and AG-UI projector.
 */

import type { AskRequest, MeridianError } from "../interrupt/index.js";
import type { AgentReport, SpawnResult } from "../spawn/index.js";
import type {
  BlockStatus,
  BlockType,
  FinishReason,
  JournalEventType,
  JsonValue,
  PriceSource,
  Turn,
} from "./index.js";

export interface ModelResponseReceivedRow {
  id: string;
  turnId: string;
  sequence: number;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: string | null;
  millicredits?: string | null;
  priceSource?: PriceSource;
  pricingSnapshot?: JsonValue | null;
  finishReason?: FinishReason | null;
  rawUsage?: JsonValue | null;
}

export interface BlockUpsertedRow {
  id: string;
  turnId: string;
  responseId?: string | null;
  blockType: BlockType;
  sequence: number;
  content: JsonValue;
  provider?: string | null;
  status: BlockStatus;
}

/** Produced orchestrator events persisted as event_journal payloads and replayed to live projections. */
export type OrchestratorEvent =
  | { type: "turn.created"; turn: Turn }
  | {
      type: "stream.delta";
      kind: "text" | "reasoning" | "tool_call";
      text?: string;
      toolCallId?: string;
      toolName?: string;
      argumentsDelta?: string;
    }
  | { type: "tool.executing"; toolCallId: string; name: string }
  | {
      /** Best-effort live stdout/stderr; authoritative final output still arrives via tool.result. */
      type: "tool.output_delta";
      toolCallId: string;
      stream: "stdout" | "stderr";
      /** Incremental chunk, not cumulative text. Consumers append chunks in event order. */
      text: string;
    }
  | { type: "tool.result"; toolCallId: string; output: JsonValue; isError?: boolean }
  | { type: "model.response_received"; response: ModelResponseReceivedRow }
  | { type: "block.upserted"; block: BlockUpsertedRow }
  | { type: "block.pruned"; blockId: string }
  | {
      type: "interrupt.created";
      turnId: string;
      interruptId: string;
      blockSequence: number;
      request: AskRequest;
    }
  | {
      type: "interrupt.resolved";
      turnId: string;
      interruptId: string;
      blockSequence: number;
      value: JsonValue;
    }
  | { type: "interrupt.expired"; turnId: string; interruptId: string; blockSequence: number }
  | {
      type: "permission.denied";
      toolCallId: string;
      toolName: string;
      category: "tool_denied";
      reason: string;
    }
  | {
      type: "usage";
      responseId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      costUsd: string;
      turnCostUsd: string;
      threadCostUsd?: string;
      model?: string | null;
      provider?: string | null;
    }
  | {
      type: "agent.spawn";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      agentSlug: string;
      prompt: string;
    }
  | {
      type: "agent.spawn_completed";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      result: SpawnResult;
    }
  | {
      type: "background.started";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      agentSlug: string;
      description?: string;
    }
  | {
      type: "background.completed";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      agentSlug: string;
      result: SpawnResult;
    }
  | {
      type: "background.failed";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId?: string;
      agentSlug: string;
      error: string;
    }
  | {
      type: "agent.handoff";
      sourceThreadId: string;
      targetThreadId: string;
      targetAgentSlug: string | null;
      summary: string;
    }
  | {
      type: "agent.fork";
      sourceThreadId: string;
      targetThreadId: string;
      targetAgentSlug: string | null;
      originTurnId: string;
    }
  | { type: "turn.completed"; turn: Turn }
  | { type: "turn.cancelled"; turn: Turn }
  | {
      type: "turn.change_trail_updated";
      eventId: string;
      threadId: string;
      trailId: string;
      turnId: string | null;
      version: number;
      counts: { changes: number; swept: number; documents: number };
    }
  | {
      type: "turn.change_trail_settled";
      eventId: string;
      threadId: string;
      trailId: string;
      turnId: string | null;
      version: number;
    }
  | { type: "turn.error"; turn: Turn; error: MeridianError };

export type { AgentReport, SpawnResult };

type Assert<T extends true> = T;

type _OrchestratorEventTypesAreRegistered = Assert<
  OrchestratorEvent["type"] extends JournalEventType ? true : false
>;
