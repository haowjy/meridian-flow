import type { MeridianError } from "../errors/index.js";
import type { PromptBakeId, TurnId } from "../ids.js";
import type { McpScriptCall } from "../mcp/tool-results.js";
import type { AgentReport, SavedOutcome, SpawnResult } from "../spawn/index.js";
import type { WorkContextProjectionSignal } from "../works/index.js";
import type { ThreadAsk } from "./asks.js";
import type {
  BlockStatus,
  BlockType,
  FinishReason,
  JournalEventType,
  JsonValue,
  PriceSource,
  ThreadActivity,
  ThreadStatus,
  Turn,
} from "./index.js";
import type {
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
} from "./prefix-cache-prediction.js";
import type { RunState } from "./run-state.js";
import type { ToolContentPart } from "./tool-result-content.js";

export interface ModelResponseReceivedRow {
  id: string;
  turnId: string;
  sequence: number;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheReset?: boolean;
  costUsd?: string | null;
  millicredits?: string | null;
  priceSource?: PriceSource;
  pricingSnapshot?: JsonValue | null;
  finishReason?: FinishReason | null;
  latencyMs?: number | null;
  requestMessageCount: number;
  requestStartedAt?: string | null;
  timeToFirstTokenMs?: number | null;
  generationMs?: number | null;
  rawUsage?: JsonValue | null;
  predictedCacheState: PrefixCachePredictionState;
  predictedCacheReason: PrefixCachePredictionReason;
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

export type WorkContextChangedEvent = {
  type: "work_context.changed";
  turnId: TurnId;
} & WorkContextProjectionSignal;

export type OrchestratorEvent =
  | WorkContextChangedEvent
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
  | { type: "ask.updated"; ask: ThreadAsk }
  | {
      type: "tool.output_delta";
      toolCallId: string;
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "tool.connection_call";
      toolCallId: string;
      sequence: number;
      id: string;
      arguments: JsonValue;
      call?: McpScriptCall;
    }
  | {
      type: "tool.result";
      toolCallId: string;
      content: ToolContentPart[];
      result?: JsonValue;
      isError?: boolean;
      metadata?: JsonValue;
    }
  | { type: "model.response_received"; response: ModelResponseReceivedRow }
  | { type: "block.upserted"; block: BlockUpsertedRow }
  | { type: "block.updated"; block: BlockUpsertedRow }
  | {
      type: "media.inclusion_decided";
      threadId: string;
      blockId: string;
      partIndex: number;
      decisionTurnId: TurnId;
      included: boolean;
    }
  | {
      type: "context.compacted";
      compactionTurnId: TurnId;
      compactedThrough: { turnId: TurnId; blockSequence?: number };
      bakeId: PromptBakeId;
      model: string;
      tokensBefore: number;
      tokensAfter: number;
    }
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
      fromThreadId?: string;
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      agentSlug: string;
      prompt: string;
    }
  | {
      type: "agent.run_completed";
      parentThreadId: string;
      parentTurnId: string | null;
      childThreadId: string;
      execution: string;
      handle: string;
      outcome: SavedOutcome;
    }
  | {
      type: "subagent.activity";
      childThreadId: string;
      activity: ThreadActivity;
    }
  | {
      type: "messages.handed_back";
      userTurnIds: string[];
      requestId: string;
    }
  | {
      type: "turns.forgotten";
      turnIds: string[];
      byTurnId: string;
      reason: "retried" | "forgotten";
    }
  | {
      type: "run_state.changed";
      threadId: string;
      runState: Omit<RunState, "version">;
    }
  | {
      type: "thread.status";
      threadId: string;
      status: ThreadStatus;
      runningTurnId: string | null;
    }
  | {
      type: "background.started";
      parentThreadId: string;
      parentTurnId: string;
      childThreadId: string;
      agentSlug: string;
      name?: string;
    }
  | {
      type: "agent.handoff";
      sourceThreadId: string;
      targetThreadId: string;
      targetAgentSlug: string | null;
      originTurnId: string;
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
  | { type: "turn.error"; turn: Turn; error: MeridianError };

export type { AgentReport, SpawnResult };

type Assert<T extends true> = T;

type _OrchestratorEventTypesAreRegistered = Assert<
  OrchestratorEvent["type"] extends JournalEventType ? true : false
>;
