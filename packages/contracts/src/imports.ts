/** Folder/file import manifests and durable per-entry reports. */
export interface ImportManifest {
  importId: string;
  destination: { folderUri: string };
  roots: {
    rootId: number;
    kind: "folder" | "file";
    name: string;
    appJson?: string;
    meridianExport?: string;
  }[];
  folders: { rootId: number; path: string }[];
  unreadable?: { rootId: number; path: string; reason?: ImportUnreadableReason }[];
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
export type ImportFailureReason =
  | "conversion_failed"
  | "upload_failed"
  | "changed_since_chosen"
  | "too_large"
  | "edited_before_arrival"
  | "deleted_before_arrival"
  | "folder_deleted"
  | "server_error";
export type ImportSkipReason =
  | "obsidian_canvas"
  | "trash"
  | "hidden"
  | "unreadable"
  | "too_large"
  | "export_works";
export type ImportEntryReason = ImportFailureReason | ImportSkipReason;
export type ImportUnreadableReason =
  | "unreadable"
  | "permission_denied"
  | "not_found"
  | "symlink"
  | "folder_unreadable";
export interface ImportCounts {
  total: number;
  landed: number;
  failed: number;
  arriving: number;
  deleted: number;
  notImported: number;
  skipped: number;
}
export interface ImportSummary {
  importId: string;
  state: ImportState;
  /**
   * Where the import was started. `folderId` is the destination folder's id (null
   * at an area root), which keeps naming the folder after a move renames its URI.
   */
  destination: { folderUri: string; folderId: string | null };
  counts: ImportCounts;
  lastActivityAt: string;
  /** Decimal commit-ordered sequence; never coerced through a JS number. */
  version: string;
  dismissedAt: string | null;
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
  reason: ImportEntryReason | null;
  reasonParams?: { readReason: ImportUnreadableReason };
  exists: boolean;
  /**
   * The server takes this file's bytes now: planned, failed, or a landing whose
   * claim lapsed (its process died). Read at report time; senders trust it alone.
   */
  wanted: boolean;
}
export interface ImportRootReport {
  rootId: number;
  kind: "folder" | "file";
  name: string;
  /** Null for a routed export selection: its project wrapper is not created. */
  id: string | null;
  uri: string | null;
}
export interface ImportReport extends ImportSummary {
  roots: ImportRootReport[];
  entries: ImportEntryReport[];
}

/** What changed since a version: changed entries, and the roots whose node changed. */
export type ImportReportChanges = ImportSummary & {
  roots: ImportRootReport[];
  entries: ImportEntryReport[];
};

/** Stable codes for refused import requests; bounded numeric params ride beside them. */
export type ImportRefusalCode =
  | "import_not_found"
  | "entry_not_found"
  | "import_not_ready"
  | "import_not_finished"
  | "import_busy"
  | "selection_mismatch"
  | "manifest_invalid"
  | "manifest_too_large"
  | "too_many_files"
  | "too_many_nodes"
  | "path_too_long"
  | "path_too_deep"
  | "duplicate_root_id"
  | "duplicate_entry_id"
  | "duplicate_selection_path"
  | "invalid_root_path"
  | "invalid_file_root"
  | "unreadable_root_has_entries"
  | "sniff_required"
  | "sniff_length"
  | "import_too_large"
  | "destination_invalid"
  | "destination_not_found"
  | "invalid_import_file_parts"
  | "duplicate_import_entry_id"
  | "too_many_parts"
  | "import_request_too_large"
  | "invalid_import_version"
  | "open_filter_required"
  | "export_marker_root"
  | "export_marker_invalid";
