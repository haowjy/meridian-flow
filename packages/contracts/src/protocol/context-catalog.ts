/** JSON-natural protocol for the authoritative context metadata catalog. */
import type { CanonicalContextUri, ContextUriScheme } from "../context-uri.js";
import type { ContextSourceId, DocumentId, FolderId, ProjectId, UserId, WorkId } from "../ids.js";
import type { WorkSlug } from "../works/work-slug.js";
import type { Filetype, YjsTrackedSchemaType } from "./filetype.js";
import type { DocumentFileType } from "./http-types.js";

export type CatalogScope =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "none"; projectId: ProjectId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId };

export type CatalogAuthorityEntry = {
  kind: "authority";
  entryId: WorkId | `none:${string}`;
  scope: { kind: "project"; projectId: ProjectId };
  authority: { kind: "work"; workId: WorkId; workSlug: WorkSlug } | { kind: "none" };
  name: string;
  available: boolean;
} & (
  | { authority: { kind: "none" }; entityRevision?: never }
  | {
      authority: { kind: "work"; workId: WorkId; workSlug: WorkSlug };
      entityRevision: string;
    }
);

export type CatalogSourceEntry = {
  kind: "source";
  entryId: ContextSourceId;
  scope: CatalogScope;
  scheme: ContextUriScheme;
  name: string;
  uri: CanonicalContextUri;
};

export type CatalogFolderEntry = {
  kind: "folder";
  entryId: FolderId;
  scope: CatalogScope;
  sourceId: ContextSourceId;
  parentId: ContextSourceId | FolderId;
  name: string;
  path: readonly string[];
  uri: CanonicalContextUri;
  hasChildren: boolean;
};

type CatalogFileEntryBase = {
  kind: "file";
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
};

/** Persisted viewer/storage classification. It is never reconstructed from a filename. */
export type CatalogFileEntry = CatalogFileEntryBase &
  (
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

export type CatalogEntry =
  | CatalogAuthorityEntry
  | CatalogSourceEntry
  | CatalogFolderEntry
  | CatalogFileEntry;

export type CatalogChange =
  | { operation: "upsert"; ordinal: number; entry: CatalogEntry }
  | { operation: "delete"; ordinal: number; entryId: string }
  | { operation: "invalidate-subtree"; ordinal: number; rootEntryId: string };

export type CatalogCommit = {
  eventId: string;
  commitId: string;
  firstRevision: string;
  lastRevision: string;
  changes: readonly CatalogChange[];
};

export type CatalogCursor = string;

export type CatalogSnapshot = {
  scope: CatalogScope;
  generation: string;
  headRevision: string;
  cursor: CatalogCursor;
  entries: readonly CatalogEntry[];
};

export type CatalogChanges =
  | {
      kind: "delta";
      scope: CatalogScope;
      commits: readonly CatalogCommit[];
      nextCursor: CatalogCursor;
      headRevision: string;
      hasMore: boolean;
    }
  | {
      kind: "reset-required";
      scope: CatalogScope;
      reason: "expired" | "gap" | "scope_changed";
    };

export type CatalogChildrenRequest = {
  scope: CatalogScope;
  parentId: ContextSourceId | FolderId;
};
export type CatalogChildrenResult = {
  scope: CatalogScope;
  parentId: string;
  entries: readonly CatalogEntry[];
  headRevision: string;
};

export type CatalogLookupRequest =
  | { scope: CatalogScope; entryId: string; uri?: never }
  | { scope: CatalogScope; uri: CanonicalContextUri; entryId?: never };
export type CatalogLookupResult = { entry: CatalogEntry | null; headRevision: string };

export type CatalogWakeHint = {
  type: "context-catalog-hint";
  scope: CatalogScope;
  headRevision: string;
};

export function catalogScopeKey(scope: CatalogScope): string {
  switch (scope.kind) {
    case "project":
      return `project:${scope.projectId}`;
    case "user":
      return `user:${scope.userId}`;
    case "none":
      return `none:${scope.projectId}`;
    case "work":
      return `work:${scope.projectId}:${scope.workId}`;
  }
}
