import type { ProjectId } from "../ids.js";
import type { Project, ProjectStatsResponse } from "../projects/index.js";
import type {
  Block,
  BlockType,
  JsonObject,
  ModelRequestDebugRecord,
  ModelResponse,
  Thread,
  ThreadListItem,
  ThreadLiveStatus,
  Turn,
  TurnRole,
  TurnStatus,
  TurnUsage,
} from "../threads/index.js";
import type { Work } from "../works/index.js";
import type { Filetype } from "./filetype.js";
import type { YjsTrackedSchemaType } from "./yjs-multiplex.js";

export type { JsonValue } from "../threads/index.js";
export type {
  Block,
  BlockType,
  ModelResponse,
  ProjectStatsResponse,
  Thread,
  ThreadListItem,
  Turn,
  TurnRole,
  TurnStatus,
  TurnUsage,
};

export type ThreadLiveState = {
  threadId: string;
  status: ThreadLiveStatus;
  runningTurnId: string | null;
  currentAgent: string | null;
};

export type CreateProjectRequest = {
  id?: ProjectId;
  name: string;
  slug: string;
  isPersonal?: boolean;
  systemPrompt?: string | null;
  settings?: JsonObject;
};

export type CreateProjectResponse = Project;

export type ListProjectsResponse = {
  projects: Project[];
};

export type ListProjectThreadsResponse = {
  threads: ThreadListItem[];
};

export type { Work };

export type ListWorksResponse = {
  works: Work[];
};

export type ProjectContextTreeScheme = "work";

type ProjectContextTreeFileBase = {
  kind: "file";
  documentId: string;
  name: string;
  path: string;
  uri: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
};

export type ProjectContextTreeEditableFile = ProjectContextTreeFileBase & {
  editable: true;
  filetype: Filetype;
  schemaType: YjsTrackedSchemaType;
};

export type ProjectContextTreeDirectory = {
  kind: "dir";
  name: string;
  path: string;
  uri: string;
  readonly?: boolean;
  children: ProjectContextTreeNode[];
};

export type ProjectContextTreeNode = ProjectContextTreeDirectory | ProjectContextTreeEditableFile;

export type ProjectContextTreeResponse = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  tree: ProjectContextTreeDirectory;
};

export type ContextReadTrackedResponse = {
  kind: "tracked";
  path: string;
  schemaType: YjsTrackedSchemaType;
  filetype: Filetype;
  content: string;
};

export type ContextReadResponse = ContextReadTrackedResponse;

export type CreateThreadRequest = {
  id?: string;
  projectId: string;
  title?: string;
  systemPrompt?: string;
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
};

export type ModelRequestDebugListResponse = {
  records: ModelRequestDebugRecord[];
};

export type BinaryDocumentFileType = "docx" | "image" | "pdf";
export type DocumentFileType = BinaryDocumentFileType | "binary";
