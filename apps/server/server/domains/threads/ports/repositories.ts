/**
 * Thread repository ports: the persistence contracts for threads, turns, blocks,
 * model responses, and usage rollups, plus their input/result types and the
 * transactional ThreadRepositories aggregate. The boundary both adapter sets implement.
 */

import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import type { ProjectId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import type {
  ExecutionReportCorrelation,
  ExecutionReportSource,
  SavedExecutionReport,
  SavedOutcome,
} from "@meridian/contracts/spawn";
import type {
  Block,
  BlockStatus,
  BlockType,
  ExecutionSide,
  FinishReason,
  JsonValue,
  ModelResponse,
  PriceSource,
  ProjectChatItem,
  SpawnStatus,
  Thread,
  ThreadKind,
  ThreadLeaseState,
  ThreadLifecycleStatus,
  ThreadListItem,
  ThreadPendingInbox,
  ThreadStatus,
  Turn,
  TurnRole,
  TurnStatus,
  UpdateThreadUserStateResponse,
  WorkingState,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
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
  /** Replace an existing block without minting a missing card or changing its placement. */
  replaceExisting(input: UpsertBlockInput): Promise<Block | null>;
  findById(id: string): Promise<Block | null>;
  listByTurn(turnId: TurnId): Promise<Block[]>;
  /** All blocks across all turns for a thread, ordered by turn creation then block sequence. */
  listByThread(threadId: ThreadId): Promise<Block[]>;
  /** Sets the prune flag. A missing row is a no-op (`null`), not an error. */
  updatePruned(id: string, pruned: boolean): Promise<Block | null>;
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
  listByThread(threadId: ThreadId): Promise<ModelResponse[]>;
}

export interface AdmitExecutionReportInput extends ExecutionReportCorrelation {
  childThreadId: ThreadId;
  assistantTurnId: TurnId;
  handle: string;
  agentSlug?: string | null;
  description?: string | null;
}
export interface FinalizeExecutionReportInput {
  terminalAssistantTurnId?: TurnId;
  childThreadId: ThreadId;
  assistantTurnId: TurnId;
  outcome: SavedOutcome;
  reason: string | null;
  source: ExecutionReportSource;
  summary: string;
  payload?: import("@meridian/contracts/threads").JsonValue | null;
  artifacts?: ArtifactRef[] | null;
  costMillicredits?: number | null;
}
export interface ExecutionReportRepository {
  /** Nearest admitted execution on this assistant's ancestor chain. */
  findByTurn(childThreadId: ThreadId, turnId: TurnId): Promise<SavedExecutionReport | null>;
  admit(input: AdmitExecutionReportInput): Promise<SavedExecutionReport>;
  captureOnce(
    childThreadId: ThreadId,
    assistantTurnId: TurnId,
    toolCallId: string,
    capture: import("@meridian/contracts/spawn").ReturnResultCapture,
  ): Promise<SavedExecutionReport>;
  finalizeOnce(input: FinalizeExecutionReportInput): Promise<SavedExecutionReport>;
  findByExecution(
    childThreadId: ThreadId,
    assistantTurnId: TurnId,
  ): Promise<SavedExecutionReport | null>;
  /** Bounded metadata for admitted executions still lacking terminal truth. */
  listUnfinalized(
    limit: number,
    afterExecutionId?: TurnId,
  ): Promise<Array<Pick<SavedExecutionReport, "childThreadId" | "assistantTurnId">>>;
  /** Bounded, deliverable discovery. Soft-deleted callers stay pending until restoration. */
  listPendingPublication(
    limit: number,
    afterExecutionId?: TurnId,
  ): Promise<
    Array<Pick<SavedExecutionReport, "childThreadId" | "assistantTurnId" | "callerThreadId">>
  >;
  lockPendingPublication(
    childThreadId: ThreadId,
    assistantTurnId: TurnId,
  ): Promise<SavedExecutionReport | null>;
  markPublished(
    childThreadId: ThreadId,
    assistantTurnId: TurnId,
    publication: "published" | "skipped",
  ): Promise<void>;
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
  workingState?: WorkingState | null;
  parentThreadId?: ThreadId | null;
  spawnStatus?: SpawnStatus | null;
  spawnDepth?: number;
}

export interface UpdateSpawnLifecycleInput {
  spawnStatus: SpawnStatus;
}

/** Atomic first-attempt bake payload for gateway prompt + skill contract. */
export interface BakeComposedSystemPromptInput {
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
}

export interface ThreadRepository {
  create(input: CreateThreadInput): Promise<Thread>;
  updateSpawnLifecycle(id: ThreadId, input: UpdateSpawnLifecycleInput): Promise<Thread>;
  findById(id: ThreadId): Promise<Thread | null>;
  /** Exact live handle lookup by server-assigned `cN`/`pN` ref; caller must authorize the project. */
  findLiveByProjectRef(projectId: ProjectId, ref: string): Promise<Thread | null>;
  /** Returns the owning project even when the thread is soft-deleted. */
  findProjectIdByIdIncludingDeleted(id: ThreadId): Promise<ProjectId | null>;
  /** Locks and returns the thread lifecycle row, including soft-deleted threads. */
  lockByIdIncludingDeleted(id: ThreadId): Promise<Thread | null>;
  listByUser(userId: UserId): Promise<Thread[]>;
  /** Primary threads in a project (excludes subagents and soft-deleted threads; caller must gate project access). */
  listByProject(projectId: ProjectId): Promise<ThreadListItem[]>;
  /**
   * Every live descendant of `threadId` in its spawn subtree, breadth-first by
   * `(spawnDepth, createdAt, id)`. Walks `parent_thread_id` from the viewed
   * thread (so a sibling branch sharing the root is excluded), skips soft-deleted
   * rows, and never includes the thread itself. Feeds the recursive activity read.
   */
  listDescendants(threadId: ThreadId): Promise<ThreadDescendant[]>;
  /** Hard-bounded model-facing summary of primary chats historically associated with a Work. */
  listRecentByWork(
    projectId: ProjectId,
    workId: WorkId,
    limit: number,
  ): Promise<WorkThreadSummary[]>;
  updateStatus(id: ThreadId, status: ThreadLifecycleStatus): Promise<Thread>;
  /** Persists a writer-authored title and refreshes `updatedAt`; returns the authoritative row. */
  updateTitle(id: ThreadId, title: string): Promise<Thread>;
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
  //   - exclude status:"archived" from listByProject / Work feeds by default, and
  //     add a listing path for the "Archived" view to read them back.
  /** Applies a changed trash state; lifecycle commands must first hold the thread row lock. */
  setTrashState(id: ThreadId, target: "deleted" | "visible"): Promise<Thread>;
}

export interface WorkThreadSummary {
  title: string | null;
  updatedAt: string;
  status: ThreadLifecycleStatus;
}

/** One descendant in a thread's spawn subtree, as the activity read needs it. */
export type ThreadDescendant = Pick<
  Thread,
  | "id"
  | "parentThreadId"
  | "rootThreadId"
  | "spawnDepth"
  | "ref"
  | "title"
  | "agentName"
  | "spawnStatus"
  | "originTurnId"
>;

/**
 * Read seam for the derived run status. The runtime's lease authority
 * (`RunClaim`) satisfies it; the threads domain depends on this narrow
 * port rather than the runtime domain, so status stays a pure lease function.
 */
export interface ThreadStatusReader {
  read(threadId: ThreadId): Promise<ThreadStatus>;
  /** Assistant turn bound to the thread's live lease; null when asleep or unbound. */
  readRunningTurnId(threadId: ThreadId): Promise<TurnId | null>;
  /**
   * Batch lease read for a page of threads, so list reads do not re-derive
   * liveness in SQL. Only live leases appear in the map.
   */
  readMany(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadLeaseState>>;
}

/**
 * Read seam for a thread's undelivered inbox rows as the writer-facing
 * `ThreadPendingInbox`. The runtime composition supplies a projection over the
 * raw `InboxReader`; the threads domain depends on this narrow port, not the runtime
 * domain, so pending stays a pure read.
 */
export interface ThreadPendingInboxReader {
  readPending(threadId: ThreadId): Promise<ThreadPendingInbox>;
}

/** The derived live reads the snapshot builder and WS `subscribed` state share. */
export interface ThreadLiveReaders extends ThreadStatusReader, ThreadPendingInboxReader {}

export interface ProjectChatCursorKey {
  sortAt: string;
  threadId: ThreadId;
}

export interface WorkChatFeedRow {
  item: ProjectChatItem;
  updatedAt: string;
}

export interface WorkChatFeedRepository {
  queryPage(input: {
    projectId: ProjectId;
    workId: WorkId;
    userId: UserId;
    after: ProjectChatCursorKey | null;
    limit: number;
  }): Promise<WorkChatFeedRow[]>;
}

export interface HomeChatFeedRepository {
  queryPage(input: {
    projectId: ProjectId;
    userId: UserId;
    after: ProjectChatCursorKey | null;
    recentLimit: number;
    includeFeatured: boolean;
  }): Promise<{
    continueChat: ProjectChatItem | null;
    favorites: ProjectChatItem[];
    recent: ProjectChatItem[];
  }>;
}

export interface ThreadUserStateRepository {
  update(input: {
    threadId: ThreadId;
    userId: UserId;
    isFavorite: boolean;
  }): Promise<UpdateThreadUserStateResponse>;
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
  writeMode?: AiWriteMode | null;
  status?: TurnStatus;
  requestParams?: JsonValue | null;
  metadata?: JsonValue | null;
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
  /**
   * The assistant container of a run that the caller has already proven live
   * (via the runner map), or null. Durable status is not a liveness authority:
   * this is the setup-window fallback for when the runner owns the thread but
   * has not published the assistant id yet, so `createdAfter` excludes older
   * crash-orphaned non-terminal turns.
   */
  findRunningAssistantId(
    threadId: ThreadId,
    options?: { createdAfter?: Date },
  ): Promise<TurnId | null>;
  updateStatus(id: TurnId, input: UpdateTurnStatusInput): Promise<Turn>;
  /** Recomputes usage rollups from this turn's model_responses rows. */
  recomputeRollups(id: TurnId): Promise<Turn>;
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
  listThreadIdsByDocument(documentId: string): Promise<ThreadId[]>;
}

export interface ThreadWorksRepository {
  /** When primary, demotes the old primary and upserts this membership atomically. */
  addMembership(threadId: ThreadId, workId: WorkId, isPrimary: boolean): Promise<void>;
  /** Demotes the previous membership and promotes/upserts the target under the thread row lock. */
  rebindPrimary(
    threadId: ThreadId,
    workId: WorkId,
  ): Promise<{ previousWorkId: WorkId | null; changed: boolean }>;
  /** Locks the thread after callers have acquired any Work lifecycle locks. */
  lockPrimary(threadId: ThreadId): Promise<{ workId: WorkId } | null>;
  findPrimary(threadId: ThreadId): Promise<{ workId: WorkId } | null>;
  /** Upserts a primary onto an already-locked Work while restore holds the thread row lock. */
  rebindPrimaryForRestore(threadId: ThreadId, workId: WorkId): Promise<void>;
  listByThread(threadId: ThreadId): Promise<Array<{ workId: WorkId; isPrimary: boolean }>>;
}

/** A membership target belongs to a different project than its thread. */
export class ThreadWorkProjectMismatchError extends Error {
  constructor(readonly workId: WorkId) {
    super("Work is not available in this project");
    this.name = "ThreadWorkProjectMismatchError";
  }
}

/** Membership mutation lost the thread lifecycle race under its row lock. */
export class ThreadMembershipUnavailableError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("Thread is unavailable for membership mutation");
    this.name = "ThreadMembershipUnavailableError";
  }
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
  listThreadIdsByDocument(documentId: string): Promise<ThreadId[]>;
}

export type ThreadRepositories = {
  threads: ThreadRepository;
  homeFeed: HomeChatFeedRepository;
  workChatFeed: WorkChatFeedRepository;
  threadUserState: ThreadUserStateRepository;
  threadWorks: ThreadWorksRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  modelResponses: ModelResponseRepository;
  executionReports: ExecutionReportRepository;
  /** One repeatable-read snapshot for authorization-sensitive multi-repository reads. */
  readSnapshot<T>(operation: () => Promise<T>): Promise<T>;
  threadDocuments: ThreadDocumentRepository;
  documentTouches: TurnDocumentTouchRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * Serializes a complete turn-start transition on the thread and rejects
   * when another transition advanced the expected active leaf first.
   */
  runTurnStartTransition<T>(
    threadId: ThreadId,
    expectedActiveLeafTurnId: TurnId | null,
    operation: () => Promise<T>,
  ): Promise<T>;
};

/** Adapter-level aggregate used only at composition time for internal spawn wiring. */
export type InternalThreadRepositories = ThreadRepositories & {
  threads: ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory;
};
