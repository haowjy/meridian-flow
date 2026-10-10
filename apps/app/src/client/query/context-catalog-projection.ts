/** Flat UI projection types over the replica-owned normalized catalog. */
import type {
  DocumentFileType,
  Filetype,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type {
  CatalogCacheView,
  ResourceDestination,
  ResourceLocation,
} from "@meridian/resource-replica";

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
  kind: "dir";
  entryId: string;
  parentId: string | null;
  name: string;
  path: string;
  uri: string;
  /** A refused rename or move put this folder back; the writer retries from here. */
  namespaceFailure?: "set-location";
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
  current: ResourceLocation,
): ResourceDestination | undefined {
  if (!destination) return undefined;
  const segments = (path: string) => path.split("/").filter(Boolean);
  const parent = segments(current.path).slice(0, -1).join("/");
  return destination.scheme !== current.scheme ||
    destination.workId !== current.workId ||
    destination.rootThreadId !== current.rootThreadId ||
    segments(destination.folderPath).join("/") !== parent
    ? destination
    : undefined;
}
