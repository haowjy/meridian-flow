import type { CanonicalContextUri } from "../context-uri.js";
import type {
  ContextSourceId,
  DocumentId,
  DraftId,
  FolderId,
  ProjectId,
  UserId,
  WorkId,
} from "../ids.js";
import type { ContextSourcesHint } from "./context-sources.js";
import type { Filetype, TrackedSchemaType } from "./filetype.js";
import type { DocumentFileType } from "./http-types.js";

export type CatalogScope =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string }
  | { kind: "chat"; projectId: ProjectId; chatId: string };

export type CatalogFolderEntry = {
  kind: "folder";
  locationVersion?: string;
  entryId: FolderId;
  scope: CatalogScope;
  sourceId: ContextSourceId;
  parentId: ContextSourceId | FolderId;
  name: string;
  path: readonly string[];
  uri: CanonicalContextUri;
  hasChildren: boolean;
  rank?: string | null;
  navigationOnly?: true;
};

type CatalogFileEntryBase = {
  kind: "file";
  locationVersion?: string;
  entryId: DocumentId;
  scope: CatalogScope;
  sourceId: ContextSourceId;
  parentId: ContextSourceId | FolderId;
  name: string;
  aliases: readonly string[];
  path: readonly string[];
  uri: CanonicalContextUri;
  provisionalName: boolean;
  hasProperties?: boolean;
  rank?: string | null;
  joinedFrom?: readonly DocumentId[];
  upload?: { attachedAt: string; used: boolean; intakeId: string; locationRevision: string };
};

export type CatalogFileClassification = { extension: string } & (
  | {
      editable: true;
      filetype: Filetype;
      schemaType: TrackedSchemaType;
      fileType?: never;
      mimeType?: never;
    }
  | {
      editable: false;
      disposition: "binary";
      fileType: DocumentFileType;
      mimeType: string | null;
      filetype?: never;
      schemaType?: never;
    }
  | {
      editable: false;
      disposition: "custom";
      fileType: DocumentFileType;
      mimeType: string | null;
      filetype: Filetype;
      schemaType?: never;
    }
);

export type CatalogFileEntry = CatalogFileEntryBase & CatalogFileClassification;

export type DraftHint = {
  type: "draft-hint";
  projectId: ProjectId;
  draft: DraftId;
};

export type ProjectChatsHint = {
  type: "project-chats-hint";
  projectId: ProjectId;
  removedChatIds?: string[];
  recheckTabs?: true;
};

export type AgentFilesHint = { type: "agent-files-hint"; projectId: ProjectId };

export type McpConnectionsHint = { type: "mcp-connections-hint"; projectId: ProjectId };

export type CatalogChannelMessage =
  | DraftHint
  | ProjectChatsHint
  | ContextSourcesHint
  | AgentFilesHint
  | McpConnectionsHint;
