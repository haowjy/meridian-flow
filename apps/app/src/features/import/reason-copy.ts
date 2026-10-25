/** Server codes become writer-facing sentences here, never raw error messages. */
import { t } from "@lingui/core/macro";
import type { ImportEntryReason, ImportRefusalCode } from "@meridian/contracts";
export function failureSentence(reason: ImportEntryReason | null | undefined): string {
  switch (reason) {
    case "too_large":
      return t`It's over the import size limit.`;
    case "kept_as_file":
      return t`Couldn't read this Word document. Kept as a file.`;
    case "changed_after_pick":
      return t`Changed after you picked it.`;
    case "upload_lost":
      return t`The uploaded file is no longer available.`;
    case "not_found":
      return t`Not in the folder you picked.`;
    case "unreadable":
      return t`This file couldn't be read.`;
    case "obsidian_canvas":
      return t`Canvas and board files aren't imported.`;
    case "hidden":
      return t`Hidden file.`;
    case "trash":
      return t`In the trash folder.`;
    case "export_works":
      return t`Works aren't imported.`;
    default:
      return t`Something went wrong on our side. Try again.`;
  }
}
export function refusalSentence(code: ImportRefusalCode | null): string {
  switch (code) {
    case "too_many_files":
    case "too_many_nodes":
      return t`That's more files than one import can hold. Import fewer at a time.`;
    case "import_too_large":
    case "manifest_too_large":
    case "import_request_too_large":
      return t`That's more than one import can hold. Import less at a time.`;
    case "too_many_open_imports":
      return t`Three imports are already open. Finish or stop one before starting another.`;
    case "path_too_long":
    case "path_too_deep":
      return t`A file path in this selection is too long to import.`;
    case "selection_mismatch":
      return t`This isn't the same selection as the one already started.`;
    case "destination_not_found":
    case "destination_invalid":
      return t`The folder you chose isn't there anymore.`;
    case "export_marker_invalid":
    case "export_marker_root":
      return t`This Meridian export can't be read. Import its folders one at a time.`;
    default:
      return t`Couldn't complete the request. Check your connection and try again.`;
  }
}
