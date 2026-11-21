/** The server's listing of a project's sources and files (what availability answers with), and the hints on a project's subscription. */
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
import type { Filetype, YjsTrackedSchemaType } from "./filetype.js";
import type { DocumentFileType } from "./http-types.js";

export type CatalogScope =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string }
  | { kind: "chat"; projectId: ProjectId; chatId: string };

export type CatalogFolderEntry = {
  kind: "folder";
  /** Per-entry namespace mutation revision. */
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
  /** Device-synthesized ancestry has no server folder identity or management actions. */
  navigationOnly?: true;
};

type CatalogFileEntryBase = {
  kind: "file";
  /** Per-entry namespace mutation revision. */
  locationVersion?: string;
  entryId: DocumentId;
  scope: CatalogScope;
  sourceId: ContextSourceId;
  parentId: ContextSourceId | FolderId;
  name: string;
  aliases: readonly string[];
  path: readonly string[];
  uri: CanonicalContextUri;
  /** Catalog-visible identity state used by cross-device untitled reconciliation. */
  provisionalName: boolean;
  /** The document has imported frontmatter to show; the properties load by id. */
  hasProperties?: boolean;
  rank?: string | null;
  /**
   * Ids a device's create forwarded into this document (a join). A device holding a
   * reservation under one of them follows the join. Absent when none were.
   */
  joinedFrom?: readonly DocumentId[];
  /**
   * Set on a chat's uploads: when the file was attached, whether a sent message has used it,
   * and the identity its deletion must present (an unused upload is the only one the writer deletes).
   */
  upload?: { attachedAt: string; used: boolean; intakeId: string; locationRevision: string };
};

/**
 * Persisted viewer/storage classification. It is never reconstructed from a filename. The stored
 * `extension` is the row's own: a name's suffix cannot say whether it is one (`Vol. 2`).
 */
export type CatalogFileClassification = { extension: string } & (
  | {
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
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

/**
 * A draft's list is stale: its pending count or records moved. The Work naming it shows its
 * count, so its row in the Works list is stale with it. Truth-free: it says to
 * ask again, never what the answer is. It rides the per-project subscription.
 */
export type DraftHint = {
  type: "draft-hint";
  projectId: ProjectId;
  draft: DraftId;
};

/**
 * A chat in the project started or ended a reply, or asked the writer or was answered, from any
 * client: the project's chat list (its Working and Waiting marks) is stale. Truth-free, like the
 * hint above. A removal names what it removed so open windows close those chats' tabs without
 * a probe: `removedChatIds` for a deleted chat, `recheckTabs` when the removed set is not known
 * (a deleted Work, or the socket client after a reconnect, when hints were lost).
 */
export type ProjectChatsHint = {
  type: "project-chats-hint";
  projectId: ProjectId;
  removedChatIds?: string[];
  recheckTabs?: true;
};

/**
 * The text of an Agent or skill file in the project's `.agents/` or the writer's `~/.agents/`
 * changed, from any client or the AI: what Mars reads of the files is stale. Truth-free.
 */
export type AgentFilesHint = { type: "agent-files-hint"; projectId: ProjectId };

/**
 * A connection of the writer's changed or was checked (its status, its address, its tools, its
 * removal): the Connections list is stale. Account-level, so every project the writer has open
 * gets it. Truth-free.
 */
export type McpConnectionsHint = { type: "mcp-connections-hint"; projectId: ProjectId };

/** What a project's subscription receives. */
export type CatalogChannelMessage =
  | DraftHint
  | ProjectChatsHint
  | ContextSourcesHint
  | AgentFilesHint
  | McpConnectionsHint;
