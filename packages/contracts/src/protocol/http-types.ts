import { z } from "zod";
import { type AgentSelection, agentSelectionSchema } from "../agents/index.js";
import type { StoredResult } from "../commands/index.js";
import { CONTEXT_URI_SCHEMES, type ContextUriScheme } from "../context-uri.js";
import { type DraftId, isDraftId, type UserId, type WorkId } from "../ids.js";
import type { ProjectDto } from "../projects/index.js";
import type {
  Block,
  BlockType,
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
  ModelResponse,
  RunState,
  Thread,
  ThreadActivity,
  ThreadListItem,
  ThreadStatus,
  Turn,
  TurnContextPreview,
  TurnRole,
  TurnStatus,
  TurnUsage,
} from "../threads/index.js";
import {
  NO_OVERRIDES,
  type ThreadOverrides,
  threadOverridesSchema,
  threadSchema,
} from "../threads/thread.js";
import type { RemovalIdentity } from "../tree-change.js";
import type { AiWriteMode, Work, WorksSnapshot } from "../works/index.js";
import type { DocumentRemovalRecord } from "./document-removal.js";
import { type Filetype, filetypeSchema, type TrackedSchemaType } from "./filetype.js";
import { admissionReceiptShape, type SubmittedReference } from "./user-turn-admission.js";
import { runStateSchema } from "./ws-protocol.js";

export type { JsonValue } from "../threads/index.js";
export type {
  Block,
  BlockType,
  ModelResponse,
  Thread,
  ThreadListItem,
  Turn,
  TurnContextPreview,
  TurnRole,
  TurnStatus,
  TurnUsage,
};

export type ThreadLiveState = {
  threadId: string;
  status: ThreadStatus;
  activity: ThreadActivity;
  runState: RunState;
};

export type CreateProjectRequest = {
  id?: string;
  title: string;
  description?: string | null;
};

export type CreateProjectResponse = ProjectDto;

export type UpdateProjectRequest = {
  title?: string;
  description?: string | null;
};

export type ListProjectsResponse = {
  projects: ProjectDto[];
};

export type ListProjectThreadsResponse = {
  threads: ThreadListItem[];
};

export type { ProjectChatFeedPage as ListWorkThreadsResponse } from "../threads/project-chat-feed.js";

export type { AiWriteMode, Work };

export type ListWorksResponse = WorksSnapshot;

export const PROJECT_CONTEXT_TREE_SCHEMES = CONTEXT_URI_SCHEMES;

export type ProjectContextTreeScheme = ContextUriScheme;

export type TrashRetention =
  | { kind: "scheduled"; purgeAt: string }
  | { kind: "held"; works: Array<{ id: string; name: string }> };

export type DocumentTrashEntry = {
  documentId: string;
  name: string;
  scheme: ProjectContextTreeScheme;
  formerPath: string;
  removal: RemovalIdentity;
  actor: DocumentRemovalRecord["actor"];
  retention: TrashRetention;
};

export type TrashEntryFacts = {
  nodeId: string;
  removal: RemovalIdentity;
  actor: DocumentRemovalRecord["actor"];
  retention: TrashRetention;
};

export type ListTrashResponse = {
  entries: TrashEntryFacts[];
};

export type ContextDestinationParent = {
  createFolders?: string[];
} & (
  | { kind: "folder"; folderId: string }
  | {
      kind: "root";
      scheme: ProjectContextTreeScheme;
      owner: { workId: string | null; rootThreadId?: string | null };
    }
);

export type ContextSiblingPosition =
  | { kind: "before" | "after"; siblingId: string }
  | { kind: "start" | "end" };

export type ContextEntryRef = { kind: "file" | "folder"; nodeId: string };

export type CopyContextEntryView = { kind: "live" } | { kind: "draft"; draft: DraftId };

export type CopyContextEntrySource = {
  scheme: ProjectContextTreeScheme;
  path: string;
  expected: { kind: "file" | "folder"; nodeId: string };
  workId?: WorkId | null;
  rootThreadId?: string | null;
  chatRef?: string | null;
  view?: CopyContextEntryView;
  copyId?: string;
  roomVersion?: string;
};

export type CopyContextEntriesRequest = {
  operationId: string;
  // keep: Copy roots are ordered; copies land in that order
  sources: CopyContextEntrySource[];
  destinationScheme: ProjectContextTreeScheme;
  destinationFolderPath: string;
  destinationRootThreadId?: string | null;
  destinationWorkId?: WorkId | null;
  destinationParent?: ContextDestinationParent;
  destinationView?: CopyContextEntryView;
  position?: ContextSiblingPosition;
};

export type CopyContextEntryCreated = {
  kind: "file" | "folder";
  id: string;
  path: string;
  name: string;
  copiedFrom: string;
};

export const copyContextEntriesResultSchema = z.object({
  status: z.literal("copied"),
  entries: z.array(
    z.object({
      kind: z.enum(["file", "folder"]),
      id: z.string().min(1),
      path: z.string(),
      name: z.string(),
      copiedFrom: z.string().min(1),
    }),
  ),
  folders: z.array(z.string().min(1)),
});
export type CopyContextEntriesResult = z.infer<typeof copyContextEntriesResultSchema> &
  StoredResult;

export function isProjectContextTreeScheme(value: unknown): value is ProjectContextTreeScheme {
  return (
    typeof value === "string" && (PROJECT_CONTEXT_TREE_SCHEMES as readonly string[]).includes(value)
  );
}

export type AccountSettings = import("../preferences/index.js").AccountAppearancePreferences;

export type AuthenticatedUser = {
  userId: UserId;
  externalId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export const authIdentitySchema = z.object({ user: z.object({ userId: z.uuid() }) });

export type AuthMeResponse = { user: AuthenticatedUser };

export type ContextReadTrackedResponse = {
  kind: "tracked";
  schemaType: TrackedSchemaType;
  filetype: Filetype;
  content: string;
};

export type ContextReadBinaryResponse = {
  kind: "binary";
  // keep: Binary read URLs are short-lived; clients must not persist them
  url: string;
  drawUrl?: string;
  fileType: DocumentFileType;
  mimeType: string;
  sizeBytes: number | null;
};

export const contextReadResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tracked"),
    schemaType: z.enum(["document", "code"]),
    filetype: filetypeSchema,
    content: z.string(),
  }),
  z.object({
    kind: z.literal("binary"),
    url: z.string().min(1),
    drawUrl: z.string().min(1).optional(),
    fileType: z.enum(["docx", "image", "pdf", "binary"]),
    mimeType: z.string(),
    sizeBytes: z.number().nullable(),
  }),
]) satisfies z.ZodType<ContextReadResponse>;
export type ContextReadResponse = ContextReadTrackedResponse | ContextReadBinaryResponse;

export type CreateThreadRequest = {
  id?: string;
  draftId?: DraftId;
  projectId: string;
  title?: string;
  agentSelection: AgentSelection;
  workId?: WorkId | null;
  aiWriteMode?: AiWriteMode;
  overrides: ThreadOverrides;
};

export type CreateThreadResponse = Thread;

export const forkThreadRequestSchema = z
  .object({
    id: z.string(),
    originTurnId: z.uuid(),
  })
  .strict();

export const modelListSchema = z.object({
  reasoningLevels: z.array(z.string()),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      available: z.boolean(),
      maker: z.string().nullable(),
      efforts: z.array(z.string()),
    }),
  ),
});
export type ModelList = z.infer<typeof modelListSchema>;
export type ModelOption = ModelList["models"][number];

export const setThreadOverridesRequestSchema = z.strictObject({
  commandId: z.uuid(),
  overrides: threadOverridesSchema,
});
export type SetThreadOverridesRequest = z.infer<typeof setThreadOverridesRequestSchema>;

export const handoffThreadRequestSchema = z.strictObject({
  id: z.uuid(),
  draftId: z.string().refine(isDraftId).optional(),
  originTurnId: z.uuid(),
  agentSelection: agentSelectionSchema,
  overrides: threadOverridesSchema.default(NO_OVERRIDES),
});
export type HandoffThreadRequest = z.infer<typeof handoffThreadRequestSchema>;

export const handoffBriefRetryRequestSchema = z.strictObject({ id: z.uuid() });
export type HandoffBriefRetryRequest = z.infer<typeof handoffBriefRetryRequestSchema>;

export const replyRetryRequestSchema = z.strictObject({ id: z.uuid() });
export type ReplyRetryRequest = z.infer<typeof replyRetryRequestSchema>;

export const stopRequestSchema = z.strictObject({
  requestId: z.uuid(),
  seenThrough: z.number().int().min(0),
  seenExecutionId: z.string().min(1).nullable(),
  mine: z.array(z.uuid()).max(500),
});

export const handBackRequestSchema = z.strictObject({
  requestId: z.uuid(),
  ids: z.array(z.uuid()).min(1).max(500),
});

export const sendNowRequestSchema = z.strictObject({
  seenThrough: z.number().int().min(0),
  seenExecutionId: z.string().min(1),
  waiting: z.array(z.uuid()).min(1).max(500),
});

const userMessageBlockSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("reference"),
    kind: z.literal("document"),
    text: z.string(),
    documentId: z.string(),
    uri: z.string(),
  }),
  z.object({
    type: z.literal("reference"),
    kind: z.literal("folder"),
    text: z.string(),
    folderId: z.string(),
    uri: z.string(),
  }),
  z.object({
    type: z.literal("skill"),
    text: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
  }),
  z.object({ type: z.literal("image"), documentId: z.string(), uri: z.string() }),
]);

const handBackResultShape = {
  handedBack: z.array(
    z.object({ userTurnId: z.string(), blocks: z.array(userMessageBlockSchema) }),
  ),
  answered: z.array(z.string()),
  gone: z.array(z.string()),
};

export const stopResponseSchema = z.object({
  threadId: z.string(),
  ...handBackResultShape,
  cancelledExecutionId: z.string().nullable(),
  runState: runStateSchema,
});

export const handBackResponseSchema = z.object({
  ...handBackResultShape,
  runState: runStateSchema,
});

export const sendNowResponseSchema = z.object({
  threadId: z.string(),
  cancelledExecutionId: z.string().nullable(),
  runState: runStateSchema,
});

export type ReplyRetryResponse = {
  executionId: string | null;
  turn: Turn | null;
  runState: RunState;
};

export const REPLY_RETRY_PENDING_CODE = "retry_pending" as const;

export type ForkThreadRequest = z.infer<typeof forkThreadRequestSchema>;

export type SendMessageRequest = {
  submissionId: string;
  text: string;
  blocks: unknown;
  references: SubmittedReference[];
  activatedSkillSlugs?: string[];
};

export type ThreadAvailableSkill = {
  slug: string;
  name: string;
  description: string;
};

export const threadAvailableSkillsResponseSchema = z.object({
  skills: z.array(z.object({ slug: z.string().min(1), name: z.string(), description: z.string() })),
});
export type ThreadAvailableSkillsResponse = z.infer<typeof threadAvailableSkillsResponseSchema>;

export const sendMessageResponseSchema = z.object({
  ...admissionReceiptShape,
  status: z.literal("accepted"),
}) satisfies z.ZodType<SendMessageResponse>;

export type SendMessageResponse = {
  threadId: string;
  userTurnId: string;
  runStateVersion: string | null;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
  status: "accepted";
};

export const cancelTurnResponseSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  status: z.enum(["cancelled", "already_finished", "not_found"]),
});
export type CancelTurnResponse = z.infer<typeof cancelTurnResponseSchema>;

export type { ThreadSnapshotAncestor, ThreadSnapshotResponse } from "./thread-snapshot.js";

export type TranscriptPageResponse = {
  // keep: Transcript page entries are chronological even on newest-first pages
  entries: Array<{ turn: Turn; blocks: Block[]; ownerThreadId: string }>;
  owners: Array<{ threadId: string; ref: string; title: string | null; trashed: boolean }>;
  segment: {
    index: number;
    bakeId: string | null;
    openedBy: { turnId: string; kind: "compaction" | "other" } | null;
    compactedThrough?: { turnId: string; blockSequence?: number };
  };
  segmentBoundary: boolean;
  hasMore: boolean;
  nextCursor?: string;
  unsettledTail?: Array<{ turn: Turn; blocks: Block[] }>;
};

export type ModelRequestDebugListResponse = {
  records: ModelRequestDebugRecord[];
  retention: ModelRequestDebugRetention;
};

export const listThreadsResponseSchema = z.object({ threads: z.array(threadSchema) });
export type ListThreadsResponse = z.infer<typeof listThreadsResponseSchema>;

export type BinaryDocumentFileType = "docx" | "image" | "pdf";

export type DocumentFileType = BinaryDocumentFileType | "binary";

export type GetFigureSignedUrlResponse = {
  assetDocumentId: string;
  storageUrl: string;
  mimeType: string;
  fileType: BinaryDocumentFileType;
  name: string;
  sizeBytes: number;
  // keep: Figure signed URLs are short-lived; never persist them in a document
  signedUrl: string;
  drawUrl?: string;
  signedUrlExpiresAt: string;
};
