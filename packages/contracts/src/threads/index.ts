import type {
  BlockStatus,
  BlockType,
  ExecutionSide,
  OriginType,
  SpawnStatus,
  ThreadKind,
  ThreadStatus,
  TurnRole,
} from "../enums.js";
import type {
  AgentDefinitionId,
  ModelResponseId,
  ProjectId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
  WorkId,
} from "../ids.js";
import type { TurnStatus } from "./status.js";

export type {
  BlockStatus,
  BlockType,
  ExecutionSide,
  OriginType,
  SpawnStatus,
  ThreadKind,
  ThreadStatus,
  TurnRole,
} from "../enums.js";
export type {
  AgentDefinitionId,
  ModelResponseId,
  ProjectId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
  WorkId,
} from "../ids.js";
export type BlockId = TurnBlockId;
export type ThreadOriginType = OriginType;

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

/** Derived runtime status; archival status lives on `Thread.status`. */
export type ThreadLiveStatus = "idle" | "active" | "error" | "archived";
export type FinishReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";
export type PriceSource = "computed" | "provider_reported" | "configured_rate" | "unknown";

export type JournalEventType =
  | "turn.created"
  | "turn.completed"
  | "turn.cancelled"
  | "turn.error"
  | "stream.delta"
  | "tool.executing"
  | "tool.output_delta"
  | "tool.result"
  | "permission.denied"
  | "usage"
  | "agent.spawn"
  | "agent.spawn_completed"
  | "thread.created"
  | "file.written";

export interface Thread {
  id: ThreadId;
  projectId: ProjectId;
  workId: WorkId;
  userId: UserId;
  kind: ThreadKind;
  status: ThreadStatus;
  title: string | null;
  composedSystemPrompt?: string | null;
  systemPrompt?: string | null;
  workingState?: WorkingState | null;
  currentAgent: AgentDefinitionId | null;
  parentThreadId: ThreadId | null;
  spawnDepth: number;
  spawnStatus: SpawnStatus | null;
  spawnResult?: JsonValue | null;
  totalCostUsd: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: string;
  totalMillicredits?: string;
  responseCount: number;
};

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  prevTurnId?: TurnId | null;
  parentTurnId?: TurnId | null;
  role: TurnRole;
  status: TurnStatus;
  agentDefinitionId?: AgentDefinitionId | null;
  finishReason: FinishReason | null;
  model?: string | null;
  provider?: string | null;
  inputTokens: number;
  outputTokens: number;
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
  siblingIds: TurnId[];
  responses: ModelResponse[];
}

export interface Block {
  id: TurnBlockId;
  turnId: TurnId;
  responseId: ModelResponseId | null;
  blockType: BlockType;
  status: BlockStatus;
  sequence: number;
  textContent?: string | null;
  content: JsonValue;
  modelText?: string;
  compact?: string;
  pruned?: boolean;
  provider?: string | null;
  providerData?: JsonValue | null;
  executionSide?: ExecutionSide | null;
  collapsedContent?: string | null;
  createdAt: string;
}

export interface ModelResponse {
  id: ModelResponseId;
  turnId: TurnId;
  sequence: number;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  inputTokens: number;
  outputTokens: number;
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

export type ThreadListWork = {
  id: WorkId;
  title: string;
  lastActivityAt: string;
};

export type ThreadListItem = {
  id: ThreadId;
  projectId: ProjectId;
  workId: WorkId | null;
  title: string | null;
  status: ThreadStatus;
  liveStatus: ThreadLiveStatus;
  currentAgent: AgentDefinitionId | null;
  turnCount: number;
  updatedAt: string;
  work?: ThreadListWork | null;
};

export type ModelRequestDebugRecord = {
  threadId: ThreadId;
  turnId: TurnId;
  createdAt: string;
  systemPrompt: string;
};

export type OrchestratorTurn = {
  id: TurnId;
  threadId: ThreadId;
  role: TurnRole;
  status: TurnStatus;
  blocks: Array<{ sequence: number }>;
  createdAt: string;
  completedAt: string | null;
};

export type OrchestratorEvent =
  | { type: "turn.created"; turn: OrchestratorTurn }
  | { type: "turn.completed"; turn: OrchestratorTurn }
  | { type: "turn.error"; turn: OrchestratorTurn; message: string }
  | {
      type: "stream.delta";
      threadId: ThreadId;
      turnId: TurnId;
      kind: "text";
      text: string;
    };

export type BlockUpsertedRow = {
  block: Block;
};

export type ModelResponseReceivedRow = {
  response: ModelResponse;
};

export { blockContentRecord } from "./block-content-record.js";
export { blockPlainText } from "./block-plain-text.js";
export { checkpointIdForBlock } from "./checkpoint-id-for-block.js";
export type { TurnStatus } from "./status.js";
export { isTerminalTurnStatus } from "./status.js";
