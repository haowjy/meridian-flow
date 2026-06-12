/**
 * Purpose: Defines JSON-natural HTTP request and response DTOs for workbench, thread, work, context-tree, and figure APIs.
 * Why independent: These route payloads are the client/server wire contract and stay shared instead of living in app route handlers.
 * MULTIPLE PURPOSES: thread/workbench/work DTOs, context-tree DTOs, and figure asset DTOs.
 */

import type {
  Block,
  BlockType,
  ModelRequestDebugRecord,
  ModelResponse,
  Thread,
  ThreadListItem,
  Turn,
  TurnContextPreview,
  TurnRole,
  TurnStatus,
  TurnUsage,
} from "../threads/index.js";
import type { Workbench, WorkbenchStatsResponse } from "../workbenches/index.js";
import type { Work } from "../works/index.js";
import type { Filetype } from "./filetype.js";
import type { YjsTrackedSchemaType } from "./yjs-multiplex.js";

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
  WorkbenchStatsResponse,
};

export type ThreadLiveState = {
  threadId: string;
  status: Thread["status"];
  runningTurnId: string | null;
  currentAgent: string | null;
  nextSeq: string;
  /** WS cursor for replaying events not yet reflected in snapshot read-model rows. */
  resumeAfterSeq: string;
};

export type CreateWorkbenchRequest = {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  title: string;
  description?: string | null;
};

export type CreateWorkbenchResponse = Workbench;

export type UpdateWorkbenchRequest = {
  title?: string;
  description?: string | null;
};

export type ListWorkbenchesResponse = {
  workbenches: Workbench[];
};

export type ListWorkbenchThreadsResponse = {
  threads: ThreadListItem[];
};

export type { Work };

export type ListWorksResponse = {
  works: Work[];
};

export type WorkbenchContextTreeScheme = "kb" | "work" | "user" | "fs1";

type WorkbenchContextTreeFileBase = {
  kind: "file";
  /** Persisted documents.id UUID used by Yjs and figure routes. */
  documentId: string;
  name: string;
  /** Slash-prefixed display/routing path, e.g. `/workbench/README.md`. */
  path: string;
  /** Canonical context URI, e.g. `kb://workbench/README.md`. */
  uri: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
};

export type WorkbenchContextTreeEditableFile = WorkbenchContextTreeFileBase & {
  editable: true;
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
};

export type WorkbenchContextTreeBinaryFile = WorkbenchContextTreeFileBase & {
  editable: false;
  fileType: DocumentFileType;
  mimeType?: string;
};

export type WorkbenchContextTreeFile =
  | WorkbenchContextTreeEditableFile
  | WorkbenchContextTreeBinaryFile;

export type WorkbenchContextTreeDirectory = {
  kind: "dir";
  name: string;
  /** Slash-prefixed display/routing path; root is `/`. */
  path: string;
  uri: string;
  readonly?: boolean;
  children: WorkbenchContextTreeNode[];
};

export type WorkbenchContextTreeNode = WorkbenchContextTreeDirectory | WorkbenchContextTreeFile;

export type WorkbenchContextTreeResponse = {
  workbenchId: string;
  scheme: WorkbenchContextTreeScheme;
  tree: WorkbenchContextTreeDirectory;
};

export type ContextReadTrackedResponse = {
  kind: "tracked";
  /** Slash-prefixed display/routing path, e.g. `/workbench/README.md`. */
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
  /** Slash-prefixed display/routing path, e.g. `/workbench/report.pdf`. */
  path: string;
  /** Short-lived URL for browser preview/download; clients must not persist it. */
  url: string;
  fileType: DocumentFileType;
  mimeType: string;
};

export type ContextReadResponse = ContextReadTrackedResponse | ContextReadBinaryResponse;

export type CreateThreadRequest = {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: string;
  workbenchId: string;
  title?: string;
  systemPrompt?: string;
  /** Mars agent slug — when set, agent body becomes the thread system prompt. */
  currentAgent?: string;
  workId?: string | null;
};

export type CreateThreadResponse = Thread;

export type SendMessageRequest = {
  text: string;
};

export type SendMessageResponse = {
  threadId: string;
  userTurnId: string;
  assistantTurnId: string;
  streamCursor: string;
  status: "accepted" | "already_active";
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
  waitingForUser: boolean;
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
