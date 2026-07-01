/**
 * Purpose: Defines JSON-natural thread, turn, block, model-response, journal-event, and supporting value types.
 * Why independent: Thread snapshots and event payloads are cross-boundary contracts shared by clients, server routes, and persistence adapters.
 * MULTIPLE PURPOSES: thread DTOs, JSON value primitives, journal event vocabulary, and submodule re-exports.
 */
import type { AiWriteMode } from "../preferences/index.js";
import type { TurnStatus } from "./status.js";

export type {
  ArtifactId,
  BlockId,
  ProjectId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "../runtime/ids.js";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type WorkingState = {
  goals?: string[];
  notes?: string[];
  scratch?: JsonObject;
};

// TODO(archive-delete): make archive + delete "both real" (product decision).
// Today `archived` is dead — nothing sets it and no UI reaches it — while
// `deletedAt` soft-delete (the trash) is real but unwired. Intended model:
//   archive → status:"archived" → reversible filing, hidden from default lists,
//             browsable in an "Archived" view (unarchive returns it to idle)
//   delete  → deletedAt tombstone → trashed, excluded from every list
// Wire archive/unarchive mutations + a user-facing delete; keep them distinct.
export type ThreadStatus = "idle" | "active" | "blocked" | "error" | "archived";
export type TurnRole = "user" | "assistant" | "system" | "compaction";
export type BlockType =
  | "text"
  | "image"
  | "file"
  | "reasoning"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "custom";
export type BlockStatus = "complete" | "partial";
export type ExecutionSide = "server" | "client" | "hosted";
export type FinishReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";
export type ThreadKind = "primary" | "subagent";
export type ThreadOriginType = "spawn" | "handoff" | "fork";
export type SpawnStatus = "running" | "succeeded" | "failed" | "cancelled";
export type PriceSource = "computed" | "provider_reported" | "configured_rate" | "unknown";
export type { AiWriteMode };

/**
 * Canonical event-name registry for the thread journal and live event hub.
 *
 * OrchestratorEvent provides typed payloads for the produced durable payload union;
 * deferred names are reserved here until their producer and payload contract land.
 */
export type JournalEventType =
  /** PRODUCED NOW — real orchestrator/hub producers exist today. */
  | "turn.created"
  | "turn.completed"
  | "turn.cancelled"
  | "turn.error"
  | "interrupt.created"
  | "interrupt.resolved"
  | "interrupt.expired"
  /** EPHEMERAL transport — live hub streaming delta, not durable journal authority. */
  | "stream.delta"
  | "tool.executing"
  | "tool.output_delta"
  | "tool.result"
  | "permission.denied"
  /**
   * EPHEMERAL transport note: the live usage-ticker sense is not durable cost authority;
   * durable cost facts are recorded through produced payloads and model/turn persistence.
   */
  | "usage"
  /** DEFERRED — reserved vocabulary, payload typed when its producer lands. */
  | "block.created"
  | "block.upserted"
  | "block.delta"
  | "block.pruned"
  | "tool.invoked"
  | "tool.denied"
  | "tool.corrected"
  | "hook.verdict"
  | "agent.activated"
  | "agent.handoff"
  | "agent.fork"
  | "agent.spawn" // PRODUCED NOW — ChildRunCoordinator
  | "agent.spawn_completed" // PRODUCED NOW — ChildRunCoordinator
  | "context.assembled"
  | "context.compacted"
  | "context.skill_loaded"
  | "context.source_attached"
  | "context.source_detached"
  | "model.request_sent"
  | "model.response_received"
  | "model.retried"
  | "background.started"
  | "background.completed"
  | "background.failed"
  | "background.rearmed"
  | "background.killed"
  | "permission.requested"
  | "permission.granted"
  | "credits.consumed"
  | "credits.exhausted"
  | "thread.created"
  | "thread.branched"
  | "notification.delivered"
  | "file.written";

/** JSON-natural thread — survives JSON.parse/stringify unchanged. */
export interface Thread {
  id: string;
  /** Project this thread belongs to. */
  projectId: string;
  /** Work item this thread belongs to; null when ungrouped. */
  workId: string | null;
  userId: string;
  kind: ThreadKind;
  status: ThreadStatus;
  title: string | null;
  /** Baked system prompt output — set only by first-attempt bake or subagent creation. */
  composedSystemPrompt?: string | null;
  /**
   * Model-invocable skill slugs frozen with `composedSystemPrompt` at first attempt
   * (or subagent creation). `null` = not yet baked; `[]` = baked with no skills.
   */
  bakedSkillSlugs?: string[] | null;
  systemPrompt?: string | null;
  workingState?: WorkingState | null;
  currentAgent: string | null;
  aiWriteMode: AiWriteMode;
  nextSeq?: string;
  parentThreadId: string | null;
  /** Set when this thread was derived via handoff or fork. */
  originType?: ThreadOriginType | null;
  /** Fork/handoff anchor turn on the parent thread. */
  originTurnId?: string | null;
  /**
   * Identifies the run tree this thread belongs to. For primary threads this equals
   * the thread's own id; subagent threads (P2b) will point at the spawning root.
   * Used for run-scoped project workspace paths such as `runs/<rootThreadId>/input/…`.
   */
  rootThreadId: string;
  spawnDepth: number;
  spawnStatus: SpawnStatus | null;
  spawnResult?: JsonValue | null;
  totalCostUsd: string;
  turnCount: number;
  historySummary?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalCostUsd: string;
  totalMillicredits?: string;
  responseCount: number;
};

/** JSON-natural turn with nested blocks for snapshots and UI. */
export interface Turn {
  id: string;
  threadId: string;
  prevTurnId?: string | null;
  parentTurnId?: string | null;
  role: TurnRole;
  status: TurnStatus;
  agentDefinitionId?: string | null;
  finishReason: FinishReason | null;
  model?: string | null;
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalCostUsd: string;
  totalMillicredits?: string;
  responseCount: number;
  usage: TurnUsage | null;
  error: string | null;
  requestParams?: JsonValue | null;
  responseMetadata?: JsonValue | null;
  createdAt: string;
  completedAt: string | null;
  blocks: Block[];
  siblingIds: string[];
  responses: ModelResponse[];
}

export interface Block {
  id: string;
  turnId: string;
  responseId: string | null;
  blockType: BlockType;
  sequence: number;
  textContent?: string | null;
  content: JsonValue;
  modelText?: string;
  compact?: string;
  pruned?: boolean;
  provider?: string | null;
  providerData?: JsonValue | null;
  executionSide?: ExecutionSide | null;
  status?: BlockStatus;
  collapsedContent?: string | null;
  createdAt: string;
}

export { blockContentRecord } from "./block-content-record.js";
export { blockPlainText } from "./block-plain-text.js";
export { interruptIdForBlock } from "./interrupt-id-for-block.js";
export type { TurnStatus } from "./status.js";
export { isTerminalTurnStatus } from "./status.js";

export interface ModelResponse {
  id: string;
  turnId: string;
  sequence: number;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  usageBreakdown?: JsonValue | null;
  costUsd: string | null;
  millicredits?: string | null;
  priceSource?: PriceSource;
  pricingSnapshot?: JsonValue | null;
  finishReason?: FinishReason | null;
  stopReason?: string | null;
  requestParams?: JsonValue | null;
  responseMetadata?: JsonValue | null;
  latencyMs: number | null;
  rawUsage?: JsonValue | null;
  createdAt: string;
  completedAt?: string | null;
}

export * from "./golden/index.js";
export type { ModelRequestDebugRecord } from "./model-request-debug.js";
export type {
  BlockUpsertedRow,
  ModelResponseReceivedRow,
  OrchestratorEvent,
} from "./orchestrator-events.js";
export type { ThreadListItem, ThreadListWork } from "./projections.js";
export type {
  TurnContextPreview,
  TurnContextPreviewFunctionTool,
} from "./turn-context-preview.js";
