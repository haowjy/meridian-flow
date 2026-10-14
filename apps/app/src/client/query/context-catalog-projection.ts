/** Flat UI projection types over the replica-owned normalized catalog. */
import type { ImportEntryReason, ImportRefusalCode } from "@meridian/contracts";
import type {
  DocumentFileType,
  Filetype,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { CatalogCacheView, ParentRef, ResourceDestination } from "@meridian/resource-replica";

/** How an import touches a row: drawn by the importing tab, still arriving, or failed. */
export type ImportRowInfo = {
  /** Not a catalog entry yet; the importing tab draws it from its selection. */
  client?: true;
  /** Text (or the file) has not landed yet. */
  arriving?: true;
  /** An import into this folder is still reading what the writer chose. */
  reading?: true;
  /** The plan was refused or lost; this row carries the import's warning, Try again and Discard. */
  notStarted?: { importId: string; code: ImportRefusalCode | null };
  failure?: {
    importId: string;
    entryId: number;
    reason: ImportEntryReason | null;
    /** This tab still holds the file, so Retry can send it. */
    canRetry: boolean;
  };
};

type CatalogFileBase = {
  kind: "file";
  entryId: string;
  parentId: string;
  documentId: string;
  name: string;
  aliases?: readonly string[];
  path: string;
  uri: string;
  provisionalName: boolean;
  /** The document has imported properties to show; they load by document id. */
  hasProperties: boolean;
  /** The document is an import placeholder whose text has not landed yet. */
  importPending?: boolean;
  import?: ImportRowInfo;
  /** Present only for a locally owned resource not yet represented by server authority. */
  resourceHandle?: string;
  resourceState?: "local" | "acknowledged";
  resourceOrigin?: "local";
  /** Exact device content can open without a fresh server read. */
  localContent?: true;
  /** The writer's own move of this document, or of a folder above it, is not yet confirmed. */
  placementPending?: true;
  /** Durable namespace work that needs the writer to retry. */
  namespaceFailure?: "delete" | "set-location";
  namespaceRepairName?: string;
  namespaceRepairMove?: ResourceDestination;
  /** When the refusal settled locally; separates a fresh failure from one already there on load. */
  namespaceFailureAt?: number;
};

export type CatalogFile =
  | (CatalogFileBase & {
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
    })
  | (CatalogFileBase & {
      editable: false;
      disposition: "binary" | "custom";
      fileType: DocumentFileType;
      mimeType?: string;
      filetype?: Filetype;
    });

export type CatalogDirectory = {
  navigationOnly?: true;
  kind: "dir";
  entryId: string;
  parentId: string | null;
  name: string;
  path: string;
  uri: string;
  import?: ImportRowInfo;
  /** A refused rename or move put this folder back; the writer retries from here. */
  namespaceFailure?: "delete" | "set-location";
  namespaceRepairName?: string;
  namespaceRepairMove?: ResourceDestination;
  namespaceFailureAt?: number;
};

export type CatalogNode = CatalogDirectory | CatalogFile;

/** No nested children are stored: every read selects direct children by stable parent ID. */
export type CatalogContextView = {
  normalized: CatalogCacheView;
  root: CatalogDirectory;
  children(parentId: string): readonly CatalogNode[];
  files(): readonly CatalogFile[];
  findPath(path: string): CatalogFile | CatalogDirectory | null;
  findDocument(documentId: string): CatalogFile | null;
};

/** A rename retains its projected parent and owner; everything else is a move. */
export function refusedMoveDestination(
  destination: ResourceDestination | undefined,
  current: ParentRef | null,
): ResourceDestination | undefined {
  return destination && JSON.stringify(destination.parent) !== JSON.stringify(current)
    ? destination
    : undefined;
}
