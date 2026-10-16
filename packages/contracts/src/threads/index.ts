/**
 * Purpose: Defines JSON-natural thread, turn, block, model-response, journal-event, and supporting value types.
 * Why independent: Thread snapshots and event payloads are cross-boundary contracts shared by clients, server routes, and persistence adapters.
 * MULTIPLE PURPOSES: thread DTOs, JSON value primitives, journal event vocabulary, and submodule re-exports.
 */

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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// TODO(archive-delete): make archive + delete "both real" (product decision).
// Today `archived` is dead — nothing sets it and no UI reaches it — while
// `deletedAt` soft-delete (the trash) is real but unwired. Intended model:
//   archive → status:"archived" → reversible filing, hidden from default lists,
//             browsable in an "Archived" view (unarchive returns it to idle)
//   delete  → deletedAt tombstone → trashed, excluded from every list
// Wire archive/unarchive mutations + a user-facing delete; keep them distinct.
/**
 * Durable thread lifecycle. Run state (`active`/`idle`/`error`) is no longer
 * stored here; it is derived from the live lease. See {@link ThreadStatus}.
 */
export type ThreadLifecycleStatus = Thread["status"];

/** Lease phase published by the running loop; `generating` around the model call, `waiting` between tool waits. */
export type ThreadPhase = "generating" | "waiting" | "compacting";

/**
 * Derived run status: awake iff a live lease exists, with the phase the holder
 * last published. Never a second durable truth — a dead process expires its
 * lease and reads `asleep`.
 */
export type ThreadStatus =
  | { kind: "asleep" }
  | { kind: "awake"; phase: ThreadPhase; cancelRequested: boolean };

/**
 * One thread's live-lease projection: the derived run status plus the assistant
 * turn the lease is bound to. Batched lease reads (`readMany`) return this per
 * thread; a thread absent from the map is asleep.
 */
export type ThreadLeaseState = {
  status: ThreadStatus;
  runningTurnId: string | null;
  currentTool: CurrentToolCall | null;
};
/** Most recent tool call dispatched by a live run. */
export type CurrentToolCall = {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
};
export type TurnRole = Turn["role"];

/** Roles that can reserve a pending placeholder turn before its work completes. */
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

/**
 * Who authored a turn, independent of `role`: `writer` is any human send
 * (idle send or mid-run steer), `assistant` is model output, `system` is
 * everything else the platform or an agent injected (child completions,
 * Work-context updates, notices, non-writer inbox provenance). The server uses
 * this authorship to decide turn-driven thread, Work, and project activity;
 * chat visibility and rendering still key off `role`/`metadata`.
 */
export type TurnOrigin = Turn["origin"];
export type BlockType = Block["blockType"];
export type BlockStatus = NonNullable<Block["status"]>;
export type ExecutionSide = NonNullable<Block["executionSide"]>;
export type FinishReason = NonNullable<Turn["finishReason"]>;
export type ThreadKind = Thread["kind"];
export type ThreadOriginType = NonNullable<Thread["originType"]>;
export type SpawnStatus = NonNullable<Thread["spawnStatus"]>;
export type PriceSource = NonNullable<ModelResponse["priceSource"]>;

/** One live-or-recent direct child thread. Derived; never persisted as a block. */
export type ThreadActivityNode = {
  threadId: string;
  /** Immediate spawner. */
  parentThreadId: string | null;
  /** Server-assigned `pN` handle. */
  ref: string | null;
  title: string | null;
  /** Display name from the retained Agent definition. */
  agentName: string | null;
  /** Durable child lifecycle. */
  spawnStatus: SpawnStatus | null;
  /** Derived from the live lease; absent lease reads `asleep`. */
  status: ThreadStatus;
  /** Delivery behavior for this thread's latest admitted execution. */
  deliveryMode: "direct" | "background_notification" | null;
  /** Admission time for the latest run, or null before its first admitted run. */
  runStartedAt: string | null;
  /** Terminal time for the latest run, or null while it is running. */
  runEndedAt: string | null;
  /** The live run's current or most recently dispatched tool call. */
  currentTool: CurrentToolCall | null;
  /** Parent turn that spawned this thread (transcript anchor). */
  originTurnId: string | null;
};

/** Direct-child activity read for one viewed thread, ordered by createdAt. */
export type ThreadActivity = {
  children: ThreadActivityNode[];
};

/**
 * Durable inbox message intent. A directed `message` wakes the thread; a
 * `notice` supplies context without starting a run; a `control` is a writer
 * command (never chat text) that wakes the thread and executes at a run boundary.
 */
export type MessageIntent = "message" | "notice" | "control";

export {
  type ControlBody,
  compactControlBodySchema,
  controlBodySchema,
  writeModeControlBodySchema,
} from "./control-body.js";
export type EnqueueThreadControlRequest = { id: string; control: ControlBody };
/**
 * The answer to a control request: the run-state record read in one transaction under the
 * thread lock, so its `version` is the journal head the answer reflects.
 */
export type EnqueueThreadControlResponse = {
  id: string;
  /** The turn the command already produced, or null while it waits. */
  turnId: string | null;
  runState: RunState;
};
export type WithdrawThreadControlResponse = {
  outcome: "withdrawn" | "already_started";
  /** The record the withdrawal's own transaction published, from `answerRunState`. */
  runState: RunState;
};

/** Who authored a durable inbox message. JSON-natural; ids are plain strings at the wire. */
export type MessageProvenance =
  | { kind: "writer"; actorId: string }
  | {
      kind: "agent";
      threadId: string;
      /**
       * Set when a parent re-tasks its own child: the parent's invoking turn and
       * tool call. The run that adopts the message reports back to the parent.
       */
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

/**
 * One durably unacknowledged inbox row with server-derived delivery progress.
 * `waiting` alone belongs in the writer's queued tray; never a persisted block.
 */
export type PendingInboxItem = {
  id: string;
  seq: number;
  intent: MessageIntent;
  control?: ControlBody;
  provenance: MessageProvenance;
  deliveryState: "awaiting_run" | "waiting";
  /** Body text, or a report/notice summary. */
  summary: string;
  enqueuedAt: string;
};

/**
 * Canonical event-name registry for the thread journal and live event hub.
 *
 * OrchestratorEvent provides typed payloads for the produced durable payload union;
 * deferred names are reserved here until their producer and payload contract land.
 */
export type JournalEventType =
  | "work_context.changed"
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
  | "image.inclusion_decided"
  | "block.updated"
  | "block.delta"
  | "tool.invoked"
  | "tool.denied"
  | "tool.corrected"
  | "hook.verdict"
  | "agent.activated"
  | "agent.handoff"
  | "agent.fork"
  | "agent.spawn" // PRODUCED NOW — ChildRunCoordinator
  | "agent.run_completed" // PRODUCED NOW — ReportPublisher B, body-free metadata
  | "subagent.activity" // PRODUCED NOW — ChildRunCoordinator/Driver (direct-parent journal, direct children)
  | "messages.handed_back" // PRODUCED NOW — waiting writer messages left the chat (Stop, the queue's x, Cancel queue)
  | "turns.forgotten" // PRODUCED NOW — a failed attempt left the conversation (the writer retried it, or the chat moved past it)
  | "run_state.changed" // PRODUCED NOW — the chat's run-state record, before every commit that changed its inputs
  | "thread.status" // PRODUCED NOW — non-lease work status refresh
  | "context.assembled"
  | "context.compacted"
  | "context.skill_loaded"
  | "context.source_attached"
  | "context.source_detached"
  | "model.request_sent"
  | "model.response_received"
  | "model.retried"
  | "background.started" // PRODUCED NOW — launch metadata; terminal truth is agent.run_completed
  | "background.rearmed"
  | "background.killed"
  | "permission.requested"
  | "permission.granted"
  | "credits.consumed"
  | "credits.exhausted"
  | "thread.created"
  | "thread.branched"
  | "notification.delivered"
  | "turn.change_trail_updated"
  | "turn.change_trail_settled"
  | "file.written";

/** JSON-natural thread — survives JSON.parse/stringify unchanged. */
export type { Thread } from "./thread.js";
export { threadSchema } from "./thread.js";
export type { Block, ModelResponse, Turn, TurnDelivery, TurnUsage } from "./turn.js";
export { blockSchema, modelResponseSchema, turnSchema, turnUsageSchema } from "./turn.js";

/** Immutable system prompt and advertised tools for one prompt epoch. */
export interface PromptBake {
  id: PromptBakeId;
  ownerThreadId: ThreadId;
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  bakedTools: JsonValue;
  contentHash: string;
  createdAt: string;
}

export { blockContentRecord } from "./block-content-record.js";
export { blockPlainText } from "./block-plain-text.js";
export * from "./golden/index.js";
export { interruptIdForBlock } from "./interrupt-id-for-block.js";
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
export { type ProviderErrorResponse, replyProviderError } from "./provider-error.js";
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
export { formatThreadRef, parseThreadRef } from "./thread-ref.js";
export type {
  TurnContextPreview,
  TurnContextPreviewFunctionTool,
} from "./turn-context-preview.js";
export * from "./turn-readers.js";

/** Attested HTTP 404 proofs. WebSocket not_found frames are not availability proofs. */
export type ThreadAvailabilityCode = "thread_not_found" | "thread_deleted";

/** Details on attested thread 404s; the project flag is only present when deleted. */
export interface ThreadAvailabilityDetails {
  authenticatedUserId: string;
  projectDeleted?: true;
}
