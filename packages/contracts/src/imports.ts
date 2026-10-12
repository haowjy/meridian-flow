/** Folder/file import manifests and durable per-entry reports. */
export interface ImportManifest {
  importId: string;
  destination: { folderUri: string };
  sort: boolean;
  roots: {
    rootId: number;
    kind: "folder" | "file";
    name: string;
    appJson?: string;
    meridianExport?: string;
  }[];
  folders: { rootId: number; path: string }[];
  entries: {
    entryId: number;
    rootId: number;
    path: string;
    size: number;
    sha256: string;
    sniff?: string;
    frontmatter?: string;
  }[];
}
export type ImportState = "planning" | "ready" | "finished";
export type ImportEntryState =
  | "planned"
  | "landing"
  | "landed"
  | "failed"
  | "skipped"
  | "deleted"
  | "not_imported";
export interface ImportFinding {
  code: string;
  message: string;
}
export interface ImportEntryReport {
  entryId: number;
  rootId: number;
  path: string;
  filename: string;
  size: number;
  sha256: string;
  documentId: string;
  kind: "note" | "docx" | "code" | "binary";
  state: ImportEntryState;
  uri: string | null;
  name: string;
  reason: string | null;
  findings: ImportFinding[];
}
export interface ImportReport {
  importId: string;
  state: ImportState;
  destination: { folderUri: string };
  sort: boolean;
  roots: {
    rootId: number;
    kind: "folder" | "file";
    name: string;
    id: string;
    uri: string | null;
  }[];
  entries: ImportEntryReport[];
}
