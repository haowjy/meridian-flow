/** Upload selections, durable import progress, and upload command contracts. */
export interface ImportSelection {
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
  entries: { entryId: number; rootId: number; path: string; size: number; modifiedAt: number }[];
}
export const IMPORT_SCHEMES = ["manuscript", "kb", "unfiled"] as const;
export type ImportScheme = (typeof IMPORT_SCHEMES)[number];
export type ImportState = "uploading" | "organizing" | "finished" | "cancelled" | "failed";
export type ImportEntryState =
  | "awaiting"
  | "received"
  | "prepared"
  | "organized"
  | "skipped"
  | "failed";
export type ImportSkipReason =
  | "obsidian_canvas"
  | "trash"
  | "hidden"
  | "unreadable"
  | "export_works"
  | "not_found";
export type ImportEntryReason =
  | ImportSkipReason
  | "too_large"
  | "kept_as_file"
  | "changed_after_pick"
  | "upload_lost"
  | "server_error";
/** Writer attention is shared by the detail list and the server's aggregate count. */
export const IMPORT_REASON_NEEDS_LOOK = {
  obsidian_canvas: false,
  trash: false,
  hidden: false,
  export_works: false,
  unreadable: true,
  not_found: true,
  too_large: true,
  kept_as_file: true,
  changed_after_pick: true,
  upload_lost: true,
  server_error: true,
} as const satisfies Record<ImportEntryReason, boolean>;
export const IMPORT_NEEDS_LOOK_REASONS = (
  Object.keys(IMPORT_REASON_NEEDS_LOOK) as ImportEntryReason[]
).filter((reason) => IMPORT_REASON_NEEDS_LOOK[reason]);

export type ImportUnreadableReason =
  | "unreadable"
  | "permission_denied"
  | "not_found"
  | "symlink"
  | "folder_unreadable";
export interface ImportCounts {
  files: number;
  bytes: number;
  received: number;
  receivedBytes: number;
  prepared: number;
  organized: number;
  skipped: number;
  failed: number;
  needsLook: number;
}
export interface ImportSummary {
  importId: string;
  projectId: string;
  state: ImportState;
  label: { kind: "folder" | "files" | "export"; name: string; count: number };
  destination: { folderUri: string; folderId: string | null; fellBack: boolean };
  root: { id: string; name: string; created: boolean } | null;
  counts: ImportCounts;
  waiting: boolean;
  lastActivityAt: string;
  reason: "organize_failed" | "expired" | null;
}
export interface ImportEntryStatus {
  entryId: number;
  rootId: number;
  path: string;
  size: number;
  modifiedAt: number;
  state: ImportEntryState;
  reason: ImportEntryReason | null;
  reasonParams?: { readReason: ImportUnreadableReason };
  documentId: string;
}
export interface ImportDetail extends ImportSummary {
  roots: ImportSelection["roots"];
  entries: ImportEntryStatus[];
}
/**
 * POST /imports/:id/files uses multipart file parts named by entryId.
 * Optional X-Import-Changed-Entries is request-level metadata (FormData cannot set
 * part headers): a comma-separated list of at most IMPORT_ADMISSION.partsPerRequest
 * nonnegative safe-integer decimal ids, without whitespace or leading zeros.
 * Every id must name a part in this request; duplicates have set semantics.
 * The transport decodes this into changedAfterPick on each part, not stored metadata.
 */
export interface ImportFilesResult {
  entries: Pick<ImportEntryStatus, "entryId" | "state" | "reason">[];
  summary: ImportSummary;
}
export interface ImportSkipsInput {
  entries: { entryId: number; reason: "unreadable" | "not_found" }[];
}
/** Stable refusal codes, with bounded numeric parameters carried separately. */
export type ImportRefusalCode =
  | "import_not_found"
  | "entry_not_found"
  | "import_not_uploading"
  | "import_not_failed"
  | "import_not_finished"
  | "import_busy"
  | "import_exists"
  | "import_finished"
  | "too_many_open_imports"
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
  | "import_too_large"
  | "destination_invalid"
  | "destination_not_found"
  | "invalid_import_file_parts"
  | "duplicate_import_entry_id"
  | "too_many_parts"
  | "import_request_too_large"
  | "open_filter_required"
  | "export_marker_root"
  | "export_marker_invalid";
