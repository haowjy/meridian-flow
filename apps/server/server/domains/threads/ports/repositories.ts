/**
 * Thread repository ports: the persistence contracts for threads, turns, blocks,
 * model responses, and usage rollups, plus their input/result types and the
 * transactional ThreadRepositories aggregate. The boundary both adapter sets implement.
 */

import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  Block,
  BlockStatus,
  BlockType,
  ExecutionSide,
  FinishReason,
  JsonValue,
  ModelResponse,
  PriceSource,
  SpawnStatus,
  Thread,
  ThreadKind,
  ThreadListItem,
  ThreadStatus,
  Turn,
  TurnRole,
  TurnStatus,
  WorkingState,
} from "@meridian/contracts/threads";
import type { CreateDerivedPrimaryThreadInput } from "../domain/thread-create-derived-primary.js";
import type { CreateSubagentThreadInput } from "../domain/thread-create-subagent.js";

export interface CreateBlockInput {
  id?: string;
  turnId: TurnId;
  blockType: BlockType;
  sequence: number;
  responseId?: string | null;
  textContent?: string | null;
  content?: JsonValue | null;
  provider?: string | null;
  providerData?: JsonValue | null;
  executionSide?: ExecutionSide | null;
  status?: BlockStatus;
  collapsedContent?: string | null;
}

export interface UpsertBlockInput extends CreateBlockInput {
  id: string;
}

export interface BlockRepository {
  create(input: CreateBlockInput): Promise<Block>;
  upsert(input: UpsertBlockInput): Promise<Block>;
  findById(id: string): Promise<Block | null>;
  listByTurn(turnId: TurnId): Promise<Block[]>;
  /** All blocks across all turns for a thread, ordered by turn creation then block sequence. */
  listByThread(threadId: ThreadId): Promise<Block[]>;
  updatePruned(id: string, pruned: boolean): Promise<Block>;
}

export interface CreateModelResponseInput {
  id?: string;
  turnId: TurnId;
  sequence: number;
  provider: string;
  model: string;
  providerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd?: string;
  millicredits?: string | null;
  priceSource: PriceSource;
  pricingSnapshot?: JsonValue | null;
  finishReason?: FinishReason | null;
  latencyMs?: number | null;
  rawUsage?: JsonValue | null;
}

export interface CreateModelResponseResult {
  row: ModelResponse;
  inserted: boolean;
}

export interface ModelResponseRepository {
  /** Inserts a response row, or returns the existing row plus `inserted:false` on response-id replay. */
  create(input: CreateModelResponseInput): Promise<CreateModelResponseResult>;
  findById(id: string): Promise<ModelResponse | null>;
  listByTurn(turnId: TurnId): Promise<ModelResponse[]>;
}

export interface CreateThreadInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: ThreadId;
  userId: UserId;
  projectId: ProjectId;
  workId?: WorkId | null;
  kind?: ThreadKind;
  title?: string | null;
  systemPrompt?: string | null;
  /** Mars agent slug when this thread is agent-bound. */
  currentAgent?: string | null;
  workingState?: WorkingState | null;
  parentThreadId?: ThreadId | null;
  spawnStatus?: SpawnStatus | null;
  spawnDepth?: number;
}

export interface UpdateSpawnLifecycleInput {
  spawnStatus: SpawnStatus;
  spawnResult?: JsonValue | null;
}

/** Atomic first-attempt bake payload for gateway prompt + skill contract. */
export interface BakeComposedSystemPromptInput {
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  expectedCurrentAgent?: string | null;
}

export interface ThreadRepository {
  create(input: CreateThreadInput): Promise<Thread>;
  updateSpawnLifecycle(id: ThreadId, input: UpdateSpawnLifecycleInput): Promise<Thread>;
  findById(id: ThreadId): Promise<Thread | null>;
  listByUser(userId: UserId): Promise<Thread[]>;
  /** Threads in a project (excludes soft-deleted threads; caller must gate project access). */
  listByProject(projectId: ProjectId): Promise<ThreadListItem[]>;
  /** Threads in a work, ordered by update time (excludes soft-deleted threads). */
  listByWork(projectId: ProjectId, workId: WorkId): Promise<ThreadListItem[]>;
  updateStatus(id: ThreadId, status: ThreadStatus): Promise<Thread>;
  /** Rebinds the thread agent only before the first prompt bake/turn; returns null after freeze. */
  updateCurrentAgent(id: ThreadId, currentAgent: string | null): Promise<Thread | null>;
  /**
   * Compare-and-swap first-attempt bake: writes only while `bakedSkillSlugs` is still
   * null. Returns the authoritative thread row (winner's bake on CAS loss).
   */
  bakeComposedSystemPrompt(id: ThreadId, input: BakeComposedSystemPromptInput): Promise<Thread>;
  /** Recomputes total cost from all model responses belonging to this thread's turns. */
  recomputeCostFromModelResponses(id: ThreadId): Promise<void>;
  updateCost(id: ThreadId, deltaCostUsd: string, turnCountIncrement?: number): Promise<void>;
  // TODO(archive-delete): make archive + delete "both real" (product decision).
  // `softDelete`/`restore` below are the trash (deletedAt). Archive is a separate,
  // reversible intent that needs wiring here:
  //   - archive(id)/unarchive(id) — set/clear status:"archived" (or fold into
  //     updateStatus) so a chat can be filed away and brought back.
  //   - exclude status:"archived" from listByProject / listByWork by default, and
  //     add a listing path for the "Archived" view to read them back.
  /** Sets `deletedAt`; idempotent if already soft-deleted. */
  softDelete(id: ThreadId): Promise<Thread>;
  /** Clears `deletedAt`; idempotent if already active. */
  restore(id: ThreadId): Promise<Thread>;
}

/**
 * Internal spawn gate bypass. Kept off ThreadRepository so route-facing
 * services cannot create subagent threads through the normal thread repo port.
 */
export interface SubagentThreadFactory {
  createSubagent(input: CreateSubagentThreadInput): Promise<Thread>;
}

export interface DerivedPrimaryThreadFactory {
  createDerivedPrimary(input: CreateDerivedPrimaryThreadInput): Promise<Thread>;
}

export interface CreateTurnInput {
  /** Event/projector callers may pre-mint the row identity before insert. */
  id?: TurnId;
  threadId: ThreadId;
  /** Event/projector callers may preserve the event-authored creation time. */
  createdAt?: string;
  prevTurnId?: TurnId | null;
  role: TurnRole;
  status?: TurnStatus;
  requestParams?: JsonValue | null;
}

export interface UpdateTurnStatusInput {
  status: TurnStatus;
  finishReason?: FinishReason | null;
  completedAt?: string | null;
  error?: string | null;
}

export interface TurnRepository {
  /** Inserts a turn row, or returns the existing row when replaying the same turn id. */
  create(input: CreateTurnInput): Promise<Turn>;
  findById(id: TurnId): Promise<Turn | null>;
  listByThread(threadId: ThreadId): Promise<Turn[]>;
  getLatestByThread(threadId: ThreadId): Promise<Turn | null>;
  updateStatus(id: TurnId, input: UpdateTurnStatusInput): Promise<Turn>;
  /** Recomputes usage rollups from this turn's model_responses rows. */
  recomputeRollups(id: TurnId): Promise<Turn>;
}

/** Response row; rollups and thread cost derive from the turn owning `response.turnId`. */
export interface RecordModelResponseUsageInput {
  response: CreateModelResponseInput;
}

export interface RecordModelResponseUsageResult {
  modelResponse: ModelResponse;
  turn: Turn;
}

export interface UsageRecorder {
  recordModelResponseUsage(
    input: RecordModelResponseUsageInput,
  ): Promise<RecordModelResponseUsageResult>;
}

export interface ThreadDocument {
  threadId: ThreadId;
  documentId: string;
  relationship: ThreadDocumentRelationship;
  firstTouchedAt: string;
  lastTouchedAt: string;
}

export interface ThreadDocumentRepository {
  attach(
    threadId: ThreadId,
    documentId: string,
    relationship: ThreadDocumentRelationship,
  ): Promise<ThreadDocument>;
  detach(threadId: ThreadId, documentId: string): Promise<void>;
  listByThread(threadId: ThreadId): Promise<ThreadDocument[]>;
}

export interface TurnDocumentTouch {
  id: string;
  turnId: TurnId;
  documentId: string;
  threadId: ThreadId;
  touchedAt: string;
}

export interface TurnDocumentTouchRepository {
  recordTouch(turnId: TurnId, documentId: string): Promise<TurnDocumentTouch>;
  listByThread(threadId: ThreadId, limit?: number): Promise<TurnDocumentTouch[]>;
}

export type ThreadRepositories = {
  threads: ThreadRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
  threadDocuments: ThreadDocumentRepository;
  documentTouches: TurnDocumentTouchRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
} & UsageRecorder;

/** Adapter-level aggregate used only at composition time for internal spawn wiring. */
export type InternalThreadRepositories = ThreadRepositories & {
  threads: ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory;
};
