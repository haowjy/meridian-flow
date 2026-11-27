import type { DraftId } from "@meridian/contracts";
import type { ArtifactRef } from "@meridian/contracts/artifacts";
import type { McpBakedConnection } from "@meridian/contracts/mcp";
import type { Project } from "@meridian/contracts/projects";
import type { ThreadDocumentRelationship } from "@meridian/contracts/protocol";
import type {
  ProjectId,
  PromptBakeId,
  ThreadId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
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
  PrefixCachePredictionReason,
  PrefixCachePredictionState,
  PriceSource,
  ProjectChatItem,
  PromptBake,
  RunState,
  SpawnStatus,
  Thread,
  ThreadKind,
  ThreadLeaseState,
  ThreadListItem,
  ThreadOverrides,
  ThreadStatus,
  Turn,
  TurnDelivery,
  TurnOrigin,
  TurnRole,
  TurnStatus,
  UpdateThreadUserStateResponse,
} from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";
import type { CreateDerivedPrimaryThreadInput } from "../domain/thread-create-derived-primary.js";
import type { CreateSubagentThreadInput } from "../domain/thread-create-subagent.js";
import type { AskRepository } from "./ask-repository.js";
import { TURN_GRAPH, type TurnGraph } from "./turn-graph.js";

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
  replaceExisting(input: UpsertBlockInput): Promise<Block | null>;
  findById(id: string): Promise<Block | null>;
  listByTurn(turnId: TurnId): Promise<Block[]>;
  listByTurnIds(turnIds: readonly TurnId[]): Promise<Block[]>;
  listToolBlocks(keys: readonly { turnId: TurnId; toolCallId: string }[]): Promise<Block[]>;
  listByThread(threadId: ThreadId): Promise<Block[]>;
}

export interface ThreadMediaInclusion {
  threadId: ThreadId;
  blockId: string;
  partIndex: number;
  decisionTurnId: TurnId;
  included: boolean;
}

export interface ThreadMediaInclusionRepository {
  findByThread(threadId: ThreadId): Promise<ThreadMediaInclusion[]>;
  listByThread(threadId: ThreadId): Promise<ThreadMediaInclusion[]>;
  set(input: ThreadMediaInclusion): Promise<void>;
}

export interface CreateModelResponseInput {
  id?: string;
  turnId: TurnId;
  sequence: number;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheReset?: boolean;
  costUsd?: string;
  millicredits?: string | null;
  priceSource: PriceSource;
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

export type LatestModelResponse = Pick<
  ModelResponse,
  "turnId" | "sequence" | "model" | "requestStartedAt" | "inputTokens" | "requestMessageCount"
>;

export interface CreateModelResponseResult {
  row: ModelResponse;
  inserted: boolean;
}

export interface ModelResponseRepository {
  create(input: CreateModelResponseInput): Promise<CreateModelResponseResult>;
  findById(id: string): Promise<ModelResponse | null>;
  findLatestByThread(threadId: ThreadId): Promise<LatestModelResponse | null>;
  findLatestForTurns(turnIds: readonly TurnId[]): Promise<LatestModelResponse | null>;
  listByTurn(turnId: TurnId): Promise<ModelResponse[]>;
  listByThread(threadId: ThreadId): Promise<ModelResponse[]>;
  sumUsageByThread(threadId: ThreadId): Promise<{
    inputTokens: number;
    cacheReadTokens: number;
    cacheReportedInputTokens: number;
    cacheReportedCalls: number;
    cacheWriteTokens: number;
    outputTokens: number;
    cacheResets: number;
  }>;
  cacheResetContext(
    threadId: ThreadId,
  ): Promise<{ hasCacheActivity: boolean; previousInputTokens: number | null }>;
}

export interface AdmitExecutionReportInput extends ExecutionReportCorrelation {
  childThreadId: ThreadId;
  executionTurnId: TurnId;
  handle: string;
  agentSlug?: string | null;
  name?: string | null;
}
export interface FinalizeExecutionReportInput {
  terminalTurnId?: TurnId;
  childThreadId: ThreadId;
  executionTurnId: TurnId;
  outcome: SavedOutcome;
  reason: string | null;
  source: ExecutionReportSource;
  summary: string;
  payload?: import("@meridian/contracts/threads").JsonValue | null;
  artifacts?: ArtifactRef[] | null;
  costMillicredits?: number | null;
}
export interface ExecutionReportRepository {
  findByTurn(childThreadId: ThreadId, turnId: TurnId): Promise<SavedExecutionReport | null>;
  admit(input: AdmitExecutionReportInput): Promise<SavedExecutionReport>;
  captureOnce(
    childThreadId: ThreadId,
    executionTurnId: TurnId,
    toolCallId: string,
    capture: import("@meridian/contracts/spawn").ReturnResultCapture,
  ): Promise<SavedExecutionReport>;
  finalizeOnce(input: FinalizeExecutionReportInput): Promise<SavedExecutionReport>;
  findByExecution(
    childThreadId: ThreadId,
    executionTurnId: TurnId,
  ): Promise<SavedExecutionReport | null>;
  withdrawNotices(childThreadIds: readonly ThreadId[]): Promise<void>;
  listLatestByChildren(childThreadIds: readonly ThreadId[]): Promise<LatestChildExecution[]>;
  listFinishedByChild(childThreadId: ThreadId): Promise<SavedExecutionReport[]>;
  listUnfinalized(
    limit: number,
    afterExecutionId?: TurnId,
  ): Promise<Array<Pick<SavedExecutionReport, "childThreadId" | "executionTurnId">>>;
  listPendingPublication(
    limit: number,
    afterExecutionId?: TurnId,
  ): Promise<
    Array<
      Pick<SavedExecutionReport, "childThreadId" | "executionTurnId"> & {
        callerThreadId: ThreadId;
      }
    >
  >;
  lockPendingPublication(
    childThreadId: ThreadId,
    executionTurnId: TurnId,
  ): Promise<SavedExecutionReport | null>;
  markPublished(
    childThreadId: ThreadId,
    executionTurnId: TurnId,
    publication: "published",
  ): Promise<void>;
}

export type LatestChildExecution = Pick<
  SavedExecutionReport,
  "childThreadId" | "deliveryMode" | "callerThreadId" | "admittedAt" | "terminalAt"
>;

export interface CreateThreadInput {
  id?: ThreadId;
  draftId?: DraftId;
  userId: UserId;
  projectId: ProjectId;
  workId?: WorkId | null;
  aiWriteMode: AiWriteMode;
  overrides?: ThreadOverrides;
  kind?: ThreadKind;
  title?: string | null;
  parentThreadId?: ThreadId | null;
  spawnStatus?: SpawnStatus | null;
  spawnDepth?: number;
}

export interface UpdateSpawnLifecycleInput {
  spawnStatus: SpawnStatus;
}

export interface PromptBakeContent {
  composedSystemPrompt: string;
  bakedSkillSlugs: string[];
  bakedTools: JsonValue;
  bakedConnections: McpBakedConnection[];
  contentHash: string;
}

export interface CreatePromptBakeInput extends PromptBakeContent {
  ownerThreadId: ThreadId;
}

export interface PromptBakeRepository {
  create(input: CreatePromptBakeInput): Promise<PromptBake>;
  findById(id: PromptBakeId): Promise<PromptBake | null>;
}

export interface ThreadRepository {
  create(input: CreateThreadInput): Promise<Thread>;
  updateSpawnLifecycle(id: ThreadId, input: UpdateSpawnLifecycleInput): Promise<Thread>;
  findById(id: ThreadId): Promise<Thread | null>;
  findByIdIncludingDeleted(
    id: ThreadId,
  ): Promise<(Thread & { project: Pick<Project, "userId" | "deletedAt"> | null }) | null>;
  findLiveByProjectRef(projectId: ProjectId, ref: string): Promise<Thread | null>;
  findProjectIdByIdIncludingDeleted(id: ThreadId): Promise<ProjectId | null>;
  lockByIdIncludingDeleted(
    id: ThreadId,
    additionalWorkIds?: readonly WorkId[],
  ): Promise<(Thread & { deletedByWorkId: WorkId | null }) | null>;
  listByUser(userId: UserId): Promise<Thread[]>;
  listByProject(projectId: ProjectId): Promise<ThreadListItem[]>;
  listChildren(threadId: ThreadId): Promise<ThreadChild[]>;
  listSubtreeIds(threadId: ThreadId, spawnedByTurnId?: TurnId): Promise<ThreadId[]>;
  cancelRunningSpawns(threadIds: readonly ThreadId[]): Promise<void>;
  listLineageChildren(input: {
    rootThreadId: ThreadId;
    parentIds: ThreadId[];
    limit: number;
    after?: { createdAt: string; id: string };
  }): Promise<Array<Thread & { upThreadId: ThreadId; siblingCount: number }>>;
  listRecentByWork(
    projectId: ProjectId,
    workId: WorkId,
    limit: number,
  ): Promise<WorkThreadSummary[]>;
  updateTitle(id: ThreadId, title: string): Promise<Thread>;
  setOverrides(id: ThreadId, overrides: ThreadOverrides): Promise<Thread>;
  setAiWriteMode(id: ThreadId, mode: AiWriteMode): Promise<void>;
  bakeInitialPrompt(
    id: ThreadId,
    input: PromptBakeContent,
  ): Promise<{ thread: Thread; bake: PromptBake }>;
  recomputeCostFromModelResponses(id: ThreadId): Promise<void>;
  updateCost(id: ThreadId, deltaCostUsd: string, turnCountIncrement?: number): Promise<void>;
  setTrashState(id: ThreadId, target: "deleted" | "visible"): Promise<Thread>;
  keepWithDeletedWork(id: ThreadId, workId: WorkId): Promise<void>;
}

export interface WorkThreadSummary {
  title: string | null;
  updatedAt: string;
}

export type ThreadChild = Pick<
  Thread,
  "id" | "parentThreadId" | "ref" | "title" | "agentName" | "spawnStatus" | "originTurnId"
>;

export interface ThreadStatusReader {
  read(threadId: ThreadId): Promise<ThreadStatus>;
  readRunningTurnId(threadId: ThreadId): Promise<TurnId | null>;
  readMany(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadLeaseState>>;
}

export interface ThreadRunStateReader {
  readRunState(threadId: ThreadId): Promise<RunState>;
}

export interface ProjectChatCursorKey {
  sortAt: string;
  threadId: ThreadId;
}

export interface ProjectChatFeedRepository {
  queryPage(input: {
    projectId: ProjectId;
    userId: UserId;
    after: ProjectChatCursorKey | null;
    limit: number;
    favorite: boolean;
    workId: WorkId | null;
    search: string | null;
  }): Promise<ProjectChatItem[]>;
}

export interface ThreadUserStateRepository {
  update(input: {
    threadId: ThreadId;
    userId: UserId;
    isFavorite: boolean;
  }): Promise<UpdateThreadUserStateResponse>;
}

export interface SubagentThreadFactory {
  createSubagent(input: CreateSubagentThreadInput): Promise<Thread>;
}

export interface DerivedPrimaryThreadFactory {
  createDerivedPrimary(
    input: CreateDerivedPrimaryThreadInput,
  ): Promise<{ thread: Thread; created: boolean }>;
}

export interface CreateTurnInput {
  id?: TurnId;
  threadId: ThreadId;
  createdAt?: string;
  prevTurnId?: TurnId | null;
  promptBakeId?: PromptBakeId | null;
  compactionModel?: string | null;
  role: TurnRole;
  origin: TurnOrigin;
  writeMode?: AiWriteMode | null;
  status?: TurnStatus;
  executionId?: string | null;
  reservedForUserTurnIds?: readonly string[] | null;
  requestParams?: JsonValue | null;
  metadata?: JsonValue | null;
}

export interface UpdateTurnStatusInput {
  status: TurnStatus;
  finishReason?: FinishReason | null;
  completedAt?: string | null;
  error?: string | null;
  promptBakeId?: PromptBakeId | null;
  compactionModel?: string | null;
  metadata?: JsonValue | null;
}

export interface TranscriptSpan {
  threadId: ThreadId;
  afterPosition: number;
  throughPosition: number | null;
}

export interface TranscriptKey {
  position: number;
  sequence: number;
}

export interface TranscriptItemRow {
  turn: Turn;
  block: Block | null;
  sequence: number;
}

export interface ReadTranscriptItemsInput {
  spans: readonly TranscriptSpan[];
  order: "newest_first" | "oldest_first";
  unit: "item" | "turn";
  limit: number;
  after?: TranscriptKey;
  through?: TranscriptKey;
}

export interface TurnRepository {
  readonly [TURN_GRAPH]: TurnGraph;
  create(input: CreateTurnInput): Promise<Turn>;
  findById(id: TurnId): Promise<Turn | null>;
  findByControlId(threadId: ThreadId, controlId: string): Promise<Turn | null>;
  findLatestHandoffSeed(threadId: ThreadId): Promise<Turn | null>;
  listByThread(threadId: ThreadId): Promise<Turn[]>;
  listLatestLocalRequesterText(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, string>>;
  listPendingPlaceholders(
    limit: number,
    afterTurnId?: TurnId,
  ): Promise<Array<Pick<Turn, "id" | "threadId" | "role">>>;
  readTranscriptItems(input: ReadTranscriptItemsInput): Promise<TranscriptItemRow[]>;
  countConversationTurns(spans: readonly TranscriptSpan[], beforePosition: number): Promise<number>;
  findConversationTurnByOrdinal(
    spans: readonly TranscriptSpan[],
    ordinal: number,
  ): Promise<Turn | null>;
  findFirstUnsettledTranscriptTurn(spans: readonly TranscriptSpan[]): Promise<Turn | null>;
  listUnsettledForThread(threadId: ThreadId): Promise<Turn[]>;
  listByExecution(threadId: ThreadId, executionId: string): Promise<Turn[]>;
  findRetryReservation(threadId: ThreadId, replyTurnId: TurnId): Promise<Turn | null>;
  listHandedBackIds(threadId: ThreadId): Promise<ReadonlySet<string>>;
  forgetTurns(turnIds: readonly TurnId[], byTurnId: TurnId): Promise<TurnId[]>;
  listMessageDeliveries(threadId: ThreadId): Promise<Map<string, TurnDelivery>>;
  listTranscriptBoundaries(spans: readonly TranscriptSpan[]): Promise<Turn[]>;
  listUnsettledPrimaryTurns(
    limit: number,
    after?: { threadId: ThreadId; position: number },
  ): Promise<Array<Pick<Turn, "id" | "threadId" | "position" | "role" | "status">>>;
  findRunningAssistantId(
    threadId: ThreadId,
    options?: { createdAfter?: Date },
  ): Promise<TurnId | null>;
  updateStatus(id: TurnId, input: UpdateTurnStatusInput): Promise<Turn>;
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
}

export interface ThreadWorksRepository {
  addMembership(threadId: ThreadId, workId: WorkId, isPrimary: boolean): Promise<void>;
  rebindPrimary(
    threadId: ThreadId,
    workId: WorkId,
  ): Promise<{ previousWorkId: WorkId | null; changed: boolean }>;
  findPrimary(threadId: ThreadId): Promise<{ workId: WorkId } | null>;
  rebindPrimaryForRestore(threadId: ThreadId, workId: WorkId): Promise<void>;
  listByThread(threadId: ThreadId): Promise<Array<{ workId: WorkId; isPrimary: boolean }>>;
}

export class ThreadWorkProjectMismatchError extends Error {
  constructor(readonly workId: WorkId) {
    super("Work is not available in this project");
    this.name = "ThreadWorkProjectMismatchError";
  }
}

export class ThreadMembershipUnavailableError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("Thread is unavailable for membership mutation");
    this.name = "ThreadMembershipUnavailableError";
  }
}

export type ThreadRepositories = {
  asks: AskRepository;
  threads: ThreadRepository;
  chatFeed: ProjectChatFeedRepository;
  threadUserState: ThreadUserStateRepository;
  threadWorks: ThreadWorksRepository;
  turns: TurnRepository;
  blocks: BlockRepository;
  mediaInclusions: ThreadMediaInclusionRepository;
  modelResponses: ModelResponseRepository;
  executionReports: ExecutionReportRepository;
  readSnapshot<T>(operation: () => Promise<T>): Promise<T>;
  threadDocuments: ThreadDocumentRepository;
  promptBakes: PromptBakeRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  runTurnStartTransition<T>(
    threadId: ThreadId,
    expectedActiveLeafTurnId: TurnId | null,
    operation: () => Promise<T>,
  ): Promise<T>;
};

export type InternalThreadRepositories = ThreadRepositories & {
  threads: ThreadRepository & SubagentThreadFactory & DerivedPrimaryThreadFactory;
};
