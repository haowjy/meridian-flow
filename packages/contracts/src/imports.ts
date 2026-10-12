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
export interface ImportFindingParams {
  properties_unreadable: Record<string, never>;
  link_target_unavailable: { text: string; path: string };
  hidden_notes: { count: number };
  link_to_existing: { text: string; path: string };
  link_via_alias: { text: string; path: string };
  link_ambiguous: { text: string; count: number; path: string; candidates: string[] };
  link_unresolved: { text: string; folder: string };
  heading_not_followed: { text: string; name: string; heading: string };
  block_ref_dropped: { text: string; name: string };
  note_embed_to_link: { name: string };
  embed_to_link: { name: string };
  image_size_dropped: { name: string; size: string };
  kept_as_text: { callouts: number; highlights: number; tags: number; footnotes: number };
  settings_unreadable: { name: string };
  name_clash: { original: string };
  folder_note: Record<string, never>;
  binary_extension: { original: string; type: string };
  zip: { name: string };
}
export type ImportFinding = {
  [Code in keyof ImportFindingParams]: { code: Code; params: ImportFindingParams[Code] };
}[keyof ImportFindingParams];
export interface ImportCounts {
  total: number;
  landed: number;
  failed: number;
  arriving: number;
  deleted: number;
  notImported: number;
  skipped: number;
  findings: number;
}
export interface ImportSummary {
  importId: string;
  state: ImportState;
  destination: { folderUri: string };
  sort: boolean;
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
  findings: ImportFinding[];
}
export interface ImportReport extends ImportSummary {
  roots: {
    rootId: number;
    kind: "folder" | "file";
    name: string;
    /** Null for a routed export selection: its project wrapper is not created. */
    id: string | null;
    uri: string | null;
  }[];
  entries: ImportEntryReport[];
}

export type ImportReportChanges = ImportSummary & { entries: ImportEntryReport[] };

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
