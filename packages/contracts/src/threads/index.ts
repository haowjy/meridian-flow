import type { JsonValue, ProviderErrorResponse } from "@meridian-flow/runtime/gateway/shapes";
import type { McpBakedConnection } from "../mcp/index.js";
import type { PromptBakeId, ThreadId } from "../runtime/ids.js";

import type { ControlBody } from "./control-body.js";
import type { RunState } from "./run-state.js";
import type { Thread } from "./thread.js";
import type { Block, ModelResponse, Turn } from "./turn.js";

export type {
  ArtifactId,
  BlockId,
  ProjectId,
  PromptBakeId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "../runtime/ids.js";

export type { JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export function isNotesStepHeldResult(result: unknown): result is { refusal: "notes_step" } {
  return (
    result !== null &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "refusal" in result &&
    result.refusal === "notes_step"
  );
}

export type ThreadPhase = "generating" | "waiting" | "compacting";

export type ThreadStatus =
  | { kind: "asleep" }
  | { kind: "awake"; phase: ThreadPhase; cancelRequested: boolean };

export type ThreadLeaseState = {
  status: ThreadStatus;
  runningTurnId: string | null;
  currentTool: CurrentToolCall | null;
};
export type CurrentToolCall = {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
};
export type TurnRole = Turn["role"];

export const PENDING_PLACEHOLDER_ROLES = [
  "compaction",
  "system",
] as const satisfies readonly TurnRole[];
export type PendingPlaceholderRole = (typeof PENDING_PLACEHOLDER_ROLES)[number];

export function isPlaceholderRole(role: TurnRole): role is PendingPlaceholderRole {
  return PENDING_PLACEHOLDER_ROLES.some((placeholderRole) => placeholderRole === role);
}

export function isPendingPlaceholder<T extends Pick<Turn, "role" | "status">>(
  turn: T,
): turn is T & { role: PendingPlaceholderRole; status: "pending" } {
  return turn.status === "pending" && isPlaceholderRole(turn.role);
}

export type TurnOrigin = Turn["origin"];
export type BlockType = Block["blockType"];
export type BlockStatus = NonNullable<Block["status"]>;
export type ExecutionSide = NonNullable<Block["executionSide"]>;
export type FinishReason = NonNullable<Turn["finishReason"]>;
export type ThreadKind = Thread["kind"];
export type ThreadOriginType = NonNullable<Thread["originType"]>;
export type SpawnStatus = NonNullable<Thread["spawnStatus"]>;
export type PriceSource = NonNullable<ModelResponse["priceSource"]>;

export type ThreadActivityNode = {
  threadId: string;
  parentThreadId: string | null;
  ref: string | null;
  title: string | null;
  agentName: string | null;
  spawnStatus: SpawnStatus | null;
  status: ThreadStatus;
  deliveryMode: "direct" | "background_notification" | null;
  runStartedAt: string | null;
  runEndedAt: string | null;
  currentTool: CurrentToolCall | null;
  originTurnId: string | null;
};

export type ThreadActivity = {
  children: ThreadActivityNode[];
};

export type MessageIntent = "message" | "notice" | "control";

export {
  type ControlBody,
  compactControlBodySchema,
  controlBodySchema,
  writeModeControlBodySchema,
} from "./control-body.js";
export type EnqueueThreadControlRequest = { id: string; control: ControlBody };
export type EnqueueThreadControlResponse = {
  id: string;
  turnId: string | null;
  runState: RunState;
};
export type WithdrawThreadControlResponse = {
  outcome: "withdrawn" | "already_started";
  runState: RunState;
};

export type MessageProvenance =
  | { kind: "writer"; actorId: string }
  | {
      kind: "agent";
      threadId: string;
      sender?: { ref: string | null; title: string | null };
      notify?: { turnId: string; toolCallId: string };
    }
  | {
      kind: "child";
      threadId: string;
      reportId: string;
      handle: string;
      outcome: string;
      agentName: string;
    }
  | { kind: "system"; source: string };

export type PendingInboxItem = {
  id: string;
  seq: number;
  intent: MessageIntent;
  control?: ControlBody;
  provenance: MessageProvenance;
  deliveryState: "awaiting_run" | "waiting";
  summary: string;
  enqueuedAt: string;
};

export type JournalEventType =
  | "work_context.changed"
  | "turn.created"
  | "turn.completed"
  | "turn.cancelled"
  | "turn.error"
  | "ask.updated"
  | "stream.delta"
  | "tool.executing"
  | "tool.output_delta"
  | "tool.connection_call"
  | "tool.result"
  | "permission.denied"
  | "usage"
  | "block.created"
  | "block.upserted"
  | "media.inclusion_decided"
  | "block.updated"
  | "block.delta"
  | "tool.invoked"
  | "tool.denied"
  | "tool.corrected"
  | "hook.verdict"
  | "agent.activated"
  | "agent.handoff"
  | "agent.fork"
  | "agent.spawn"
  | "agent.run_completed"
  | "subagent.activity"
  | "messages.handed_back"
  | "turns.forgotten"
  | "run_state.changed"
  | "thread.status"
  | "context.assembled"
  | "context.compacted"
  | "context.skill_loaded"
  | "context.source_attached"
  | "context.source_detached"
  | "model.request_sent"
  | "model.response_received"
  | "model.retried"
  | "background.started"
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

export type { Thread, ThreadOverrides } from "./thread.js";
export { NO_OVERRIDES, threadOverridesSchema, threadSchema } from "./thread.js";
export type { Block, ModelResponse, Turn, TurnDelivery, TurnUsage } from "./turn.js";
export { blockSchema, modelResponseSchema, turnSchema, turnUsageSchema } from "./turn.js";

export interface PromptBake {
  id: PromptBakeId;
  ownerThreadId: ThreadId;
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  bakedTools: JsonValue;
  bakedConnections: McpBakedConnection[];
  contentHash: string;
  createdAt: string;
}

export { formatThreadRef, parseThreadRef } from "../handles.js";
export { blockContentRecord } from "./block-content-record.js";
export { blockPlainText } from "./block-plain-text.js";
export type {
  ModelRequestDebugCapture,
  ModelRequestDebugMessage,
  ModelRequestDebugRecord,
  ModelRequestDebugRequest,
  ModelRequestDebugRetention,
  ModelRequestDebugSummary,
  ModelRequestDebugView,
  ModelRequestPrefix,
} from "./model-request-debug.js";
export {
  deriveModelRequestDebugViews,
  renderModelRequestDebugMarkdown,
  summarizeModelRequestDebugView,
} from "./model-request-debug.js";
export type {
  BlockUpsertedRow,
  ModelResponseReceivedRow,
  OrchestratorEvent,
  WorkContextChangedEvent,
} from "./orchestrator-events.js";
export type {
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
} from "./prefix-cache-prediction.js";
export * from "./project-chat-feed.js";
export type { ThreadListItem, ThreadListWork } from "./projections.js";
export { replyProviderError } from "./provider-error.js";
export type {
  HandBackRequest,
  HandBackResponse,
  HandBackResult,
  RunState,
  SendNowRequest,
  SendNowResponse,
  StopRequest,
  StopResponse,
} from "./run-state.js";
export type { TurnStatus } from "./status.js";
export { isTerminalTurnStatus } from "./status.js";
export type { StoredMediaPart, StoredTextPart, ToolContentPart } from "./tool-result-content.js";
export { toolContentPartText, toolContentText } from "./tool-result-content.js";
export type {
  TurnContextPreview,
  TurnContextPreviewFunctionTool,
} from "./turn-context-preview.js";
export * from "./turn-readers.js";
export type { ProviderErrorResponse };

export type ThreadAvailabilityCode = "thread_not_found" | "thread_deleted";

export interface ThreadAvailabilityDetails {
  authenticatedUserId: string;
  projectDeleted?: true;
}

export * from "./asks.js";
