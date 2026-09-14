/** Flat UI projection types over the React Query-owned normalized catalog. */
import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "@meridian/resource-replica";

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
  /** Durable namespace work that needs the writer to retry. */
  namespaceFailure?: "delete" | "set-location";
  namespaceRepairName?: string;
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
};

export type CatalogNode = CatalogDirectory | CatalogFile;

/** No nested children are stored: every read selects direct children by stable parent ID. */
export type CatalogContextView = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  normalized: CatalogCacheView;
  root: CatalogDirectory;
  children(parentId: string): readonly CatalogNode[];
  files(): readonly CatalogFile[];
  findPath(path: string): CatalogFile | CatalogDirectory | null;
  findDocument(documentId: string): CatalogFile | null;
};
