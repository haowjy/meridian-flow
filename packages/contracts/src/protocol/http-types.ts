/**
 * Purpose: Defines JSON-natural HTTP request and response DTOs for project, thread, work, context-tree, and figure APIs.
 * Why independent: These route payloads are the client/server wire contract and stay shared instead of living in app route handlers.
 * MULTIPLE PURPOSES: thread/project/work DTOs, context-tree DTOs, and figure asset DTOs.
 */

import type { UserId, WorkId } from "../ids.js";
import type { Project, ProjectStatsResponse } from "../projects/index.js";
import type {
  Block,
  BlockType,
  ModelRequestDebugRecord,
  ModelResponse,
  Thread,
  ThreadAttention,
  ThreadListItem,
  Turn,
  TurnContextPreview,
  TurnRole,
  TurnStatus,
  TurnUsage,
} from "../threads/index.js";
import type { AiWriteMode, Work } from "../works/index.js";
import type { Filetype, YjsTrackedSchemaType } from "./filetype.js";

export type { JsonValue } from "../threads/index.js";
export type {
  Block,
  BlockType,
  ModelResponse,
  ProjectStatsResponse,
  Thread,
  ThreadAttention,
  ThreadListItem,
  Turn,
  TurnContextPreview,
  TurnRole,
  TurnStatus,
  TurnUsage,
};

export type ThreadLiveState = {
  threadId: string;
  status: Thread["status"];
  runningTurnId: string | null;
  currentAgent: string | null;
  /** Last event already materialized in snapshot rows; WS replay resumes strictly after it. */
  resumeAfterSeq: string;
};

export type CreateProjectRequest = {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  title: string;
  description?: string | null;
};

export type CreateProjectResponse = Project;

export type UpdateProjectRequest = {
  title?: string;
  description?: string | null;
};

export type ListProjectsResponse = {
  projects: Project[];
};

export type ListProjectThreadsResponse = {
  threads: ThreadListItem[];
};

export type { AiWriteMode, Work };

export type ListWorksResponse = {
  works: Work[];
  defaultWorkId: Work["id"];
};

export const PROJECT_CONTEXT_TREE_SCHEMES = [
  "manuscript",
  "kb",
  "scratch",
  "uploads",
  "user",
] as const;

export type ProjectContextTreeScheme = (typeof PROJECT_CONTEXT_TREE_SCHEMES)[number];

export type CreateUntitledContextDocumentRequest = {
  documentId: string;
  folderPath?: string;
};

export type CreateUntitledContextDocumentResponse = {
  status: "created" | "already-materialized";
  documentId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  /** Present only when the canonical location is Work-scoped. */
  workId?: string;
};

export type CreateUntitledContextDocumentResult =
  | CreateUntitledContextDocumentResponse
  | { status: "conflict" };

export type RenameContextEntryRequest = {
  path: string;
  newName: string;
};

export type RenameContextEntrySuccess = { status: "renamed" };
export type RenameContextEntryConflict = { status: "conflict" };
export type RenameContextEntryResult = RenameContextEntrySuccess | RenameContextEntryConflict;

export type MoveContextEntryRequest = {
  path: string;
  destinationScheme: ProjectContextTreeScheme;
  /** Scheme-relative parent folder; the empty string means the scheme root. */
  destinationFolderPath: string;
  newName?: string;
  sourceWorkId?: string;
  destinationWorkId?: string;
};

export type MoveContextEntrySuccess = {
  status: "moved";
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
};
/** Canonical, server-normalized location used by Open-existing recovery. */
export type MoveContextEntryLocator = {
  scheme: ProjectContextTreeScheme;
  path: string;
  /** Present only for scratch/uploads locations. */
  workId?: string;
};
export type MoveContextEntryConflict = {
  status: "conflict";
  collision: MoveContextEntryLocator;
};
export type MoveContextEntryRetry = {
  status: "retry";
  reason: "stale-source" | "stale-target";
};
export type MoveContextEntryResult =
  | MoveContextEntrySuccess
  | MoveContextEntryConflict
  | MoveContextEntryRetry;

export function isProjectContextTreeScheme(value: unknown): value is ProjectContextTreeScheme {
  return (
    typeof value === "string" && (PROJECT_CONTEXT_TREE_SCHEMES as readonly string[]).includes(value)
  );
}

/** Context tree schemes addressed as `scheme://<workId>/…` on the browse API. */
export const WORK_SCOPED_PROJECT_CONTEXT_TREE_SCHEMES = new Set<ProjectContextTreeScheme>([
  "scratch",
  "uploads",
]);

export function isWorkScopedProjectContextScheme(
  scheme: ProjectContextTreeScheme,
): scheme is WorkAuthorityScheme {
  return WORK_SCOPED_PROJECT_CONTEXT_TREE_SCHEMES.has(scheme);
}

export type WorkAuthorityScheme = "scratch" | "uploads";

export type WorkingSetRoute =
  | {
      scheme: Exclude<ProjectContextTreeScheme, WorkAuthorityScheme>;
      path: string;
      workId?: never;
    }
  | { scheme: WorkAuthorityScheme; path: string; workId: WorkId };

export type WorkingSetRouteParseResult =
  | { ok: true; value: WorkingSetRoute }
  | { ok: false; message: string };

export type WorkingSetRouteListParseResult =
  | { ok: true; value: WorkingSetRoute[] }
  | { ok: false; message: string };

export type ProjectWorkingSet = {
  userId: string;
  projectId: string;
  recentRoutes: WorkingSetRoute[];
  lastThreadId: string | null;
  revision: number;
  updatedAt: string;
};

export type AccountSettings = { workingSetSyncEnabled: boolean };

/** Authenticated identity resolved through Meridian's user provisioning boundary. */
export type AuthenticatedUser = {
  /** Canonical internal identity used by Meridian domain and collaboration records. */
  userId: UserId;
  /** Identity-provider namespace; never use for Meridian record attribution. */
  externalId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthMeResponse = { user: AuthenticatedUser };

export function parseWorkingSetRoute(input: unknown): WorkingSetRouteParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "Working-set route must be an object" };
  }

  const route = input as Record<string, unknown>;
  if (!isProjectContextTreeScheme(route.scheme)) {
    return { ok: false, message: "Working-set route has an unknown scheme" };
  }
  if (typeof route.path !== "string" || route.path.length === 0 || route.path.length > 1024) {
    return { ok: false, message: "Working-set route path must contain 1 to 1024 characters" };
  }

  if (isWorkScopedProjectContextScheme(route.scheme)) {
    if (typeof route.workId !== "string" || route.workId.length === 0) {
      return { ok: false, message: "Work-scoped routes require a workId" };
    }
    return {
      ok: true,
      value: { scheme: route.scheme, path: route.path, workId: route.workId as WorkId },
    };
  }

  if (route.workId !== undefined) {
    return { ok: false, message: "Non-work-scoped routes must not include a workId" };
  }
  return { ok: true, value: { scheme: route.scheme, path: route.path } };
}

export function parseWorkingSetRouteList(input: unknown): WorkingSetRouteListParseResult {
  if (!Array.isArray(input)) {
    return { ok: false, message: "Working-set routes must be an array" };
  }
  const routes: WorkingSetRoute[] = [];
  for (const entry of input) {
    const parsed = parseWorkingSetRoute(entry);
    if (!parsed.ok) return parsed;
    routes.push(parsed.value);
  }
  return { ok: true, value: routes };
}

type ProjectContextTreeFileBase = {
  kind: "file";
  /** Persisted documents.id UUID used by Yjs and figure routes. */
  documentId: string;
  name: string;
  /** Slash-prefixed display/routing path, e.g. `/project/README.md`. */
  path: string;
  /** Canonical context URI, e.g. `kb://project/README.md`. */
  uri: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
  provisionalName: boolean;
};

export type ProjectContextTreeEditableFile = ProjectContextTreeFileBase & {
  editable: true;
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
};

export type ProjectContextTreeBinaryFile = ProjectContextTreeFileBase & {
  editable: false;
  fileType: DocumentFileType;
  mimeType?: string;
};

export type ProjectContextTreeFile = ProjectContextTreeEditableFile | ProjectContextTreeBinaryFile;

export type ProjectContextTreeDirectory = {
  kind: "dir";
  name: string;
  /** Slash-prefixed display/routing path; root is `/`. */
  path: string;
  uri: string;
  readonly?: boolean;
  children: ProjectContextTreeNode[];
};

export type ProjectContextTreeNode = ProjectContextTreeDirectory | ProjectContextTreeFile;

export type ProjectContextTreeResponse = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  tree: ProjectContextTreeDirectory;
};

export type ContextReadTrackedResponse = {
  kind: "tracked";
  /** Slash-prefixed display/routing path, e.g. `/project/README.md`. */
  path: string;
  /** Yjs schema family used to render/edit this projection. */
  schemaType: YjsTrackedSchemaType;
  /** Filetype determining the viewer/editor surface. */
  filetype: Filetype;
  /** Markdown/fenced projection of the canonical Yjs document. */
  content: string;
};

export type ContextReadBinaryResponse = {
  kind: "binary";
  /** Slash-prefixed display/routing path, e.g. `/project/report.pdf`. */
  path: string;
  /** Short-lived URL for browser preview/download; clients must not persist it. */
  url: string;
  fileType: DocumentFileType;
  mimeType: string;
};

export type ContextReadResponse = ContextReadTrackedResponse | ContextReadBinaryResponse;

export type CorpusImportSourceKind = "upload" | "google_drive_fixture" | "google_drive";

export type CorpusImportItemResponse =
  | {
      status: "imported";
      filename: string;
      title: string;
      uri: string;
      documentId?: string;
      source: { kind: CorpusImportSourceKind };
      messages: string[];
    }
  | {
      status: "skipped";
      filename: string;
      title: string;
      reason: string;
      source: { kind: CorpusImportSourceKind };
    }
  | {
      status: "failed";
      filename: string;
      title: string;
      reason: string;
      source: { kind: CorpusImportSourceKind };
    };

export type CorpusImportResponse = {
  projectId: string;
  targetScheme: "kb";
  requestedCount: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  items: CorpusImportItemResponse[];
};

export type CreateThreadRequest = {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  projectId: string;
  title?: string;
  systemPrompt?: string;
  /** Mars agent slug — when set, agent body becomes the thread system prompt. */
  currentAgent?: string;
  workId?: string | null;
};

export type CreateThreadResponse = Thread;

/** Rebind agent on a thread that has not started. */
export type UpdateThreadAgentRequest = {
  /** Agent slug, or null for platform-default (no agent binding). */
  currentAgent: string | null;
};

export type UpdateThreadAgentResponse = Thread;

export type UpdateWorkWriteModeRequest = {
  aiWriteMode: AiWriteMode;
  confirmedPush?: boolean;
};

export type UpdateWorkWriteModeResponse =
  | { aiWriteMode: AiWriteMode; status: "updated" }
  | {
      aiWriteMode: AiWriteMode;
      status: "confirmation_required";
      reason: "pending_branch_changes";
      pendingChangeCount: number;
      message: string;
    };

export type SendMessageRequest = {
  text: string;
  /** Client connection token from the WebSocket `connected` frame; rejects starts from stale sockets. */
  connectionToken?: string;
};

export type SendMessageResponse = {
  threadId: string;
  userTurnId: string;
  assistantTurnId: string;
  /** Pre-start event position; the client subscription replays events strictly after it. */
  resumeAfterSeq: string;
  /**
   * Minimum snapshot nextSeq that the client may apply after acknowledgement;
   * snapshots with a smaller nextSeq are rejected.
   */
  snapshotFloorNextSeq: string;
  status: "accepted";
};

export type CancelTurnResponse = {
  threadId: string;
  turnId: string;
  status: "cancelled" | "already_finished" | "not_found";
};

export type ThreadSnapshotResponse = {
  threadId: string;
  thread: Thread;
  turns: Turn[];
  liveState: ThreadLiveState;
  attention: ThreadAttention;
  /** First event position after this snapshot; clients reject it below their stored floor. */
  nextSeq: string;
};

/** Dev-only: per-request model context captured by the orchestrator. */
export type ModelRequestDebugListResponse = {
  records: ModelRequestDebugRecord[];
};

export type ListThreadsResponse = {
  threads: Thread[];
};

export type BinaryDocumentFileType = "docx" | "image" | "pdf";

export type DocumentFileType = BinaryDocumentFileType | "binary";

export interface FigureNodeReference {
  /** Stable MyST figure src. This is not an expiring render URL. */
  src: string;
  alt: string;
  label: string | null;
  caption: string | null;
}

export interface FigureAssetReference {
  documentId: string;
  storageUrl: string;
  mimeType: string;
  fileType: BinaryDocumentFileType;
  sizeBytes: number;
  figure: FigureNodeReference;
  /** Short-lived URL for immediate browser preview/rendering. Do not persist in Yjs. */
  signedUrl: string;
  signedUrlExpiresAt: string;
}

export type UploadFigureAssetResponse = FigureAssetReference;

export type GetFigureSignedUrlResponse = {
  documentId: string;
  storageUrl: string;
  mimeType: string;
  fileType: BinaryDocumentFileType;
  signedUrl: string;
  signedUrlExpiresAt: string;
};
