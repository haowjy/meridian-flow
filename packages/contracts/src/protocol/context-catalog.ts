/** JSON-natural protocol for the authoritative context metadata catalog. */
import type { DraftOwnerKey } from "../branches/owner.js";
import type { CanonicalContextUri, ContextUriScheme } from "../context-uri.js";
import type { ContextSourceId, DocumentId, FolderId, ProjectId, UserId, WorkId } from "../ids.js";
import type { WorkAuthorityDto } from "../works/work-authority.js";
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

export type CatalogEntry = CatalogFolderEntry | CatalogFileEntry;

/**
 * A draft owner's list is stale: its pending draft count moved, or the owner's lifecycle changed
 * (a Work archived, unarchived, deleted, restored or purged; a lineage that lost or regained its
 * last live chat). For a Work, its row in the Works list is stale with it. Truth-free, like the
 * catalog hint; it rides the same per-project subscription.
 */
export type DraftOwnerHint = {
  type: "draft-owner-hint";
  projectId: ProjectId;
  owner: DraftOwnerKey;
};

/**
 * A chat in the project started or ended a reply, or asked the writer or was answered, from any
 * client: the project's chat list (its Working and Waiting marks) is stale. Truth-free, like the
 * hints above. A removal names what it removed so open windows close those chats' tabs without
 * a probe: `removedChatIds` for a deleted chat, `recheckTabs` when the removed set is not known
 * (a deleted Work, or the socket client after a reconnect, when hints were lost).
 */
export type ProjectChatsHint = {
  type: "project-chats-hint";
  projectId: ProjectId;
  removedChatIds?: string[];
  recheckTabs?: true;
};

/** What a project's subscription receives. */
export type CatalogChannelMessage = DraftOwnerHint | ProjectChatsHint | ContextSourcesHint;
