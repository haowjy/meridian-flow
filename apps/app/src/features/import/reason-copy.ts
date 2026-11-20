/** Server codes become writer-facing sentences here, never raw error messages. */
import { t } from "@lingui/core/macro";
import {
  IMPORT_REASON_NEEDS_LOOK,
  type ImportEntryReason,
  type ImportEntryStatus,
  type ImportRefusalCode,
} from "@meridian/contracts";

function failureSentence(reason: ImportEntryReason | null | undefined): string {
  switch (reason) {
    case "too_large":
      return t`Too large`;
    case "kept_as_file":
      return t`Kept as a file`;
    case "changed_after_pick":
      return t`Changed`;
    case "upload_lost":
      return t`Upload lost`;
    case "not_found":
      return t`Not found`;
    case "unreadable":
      return t`Couldn't read`;
    case "obsidian_canvas":
      return t`Not imported`;
    case "hidden":
      return t`Hidden file.`;
    case "trash":
      return t`In the trash folder.`;
    case "export_works":
      return t`Not imported`;
    default:
      return t`Couldn't import`;
  }
}
/** Every fact that puts a file on the need-a-look list; two can hold at once. */
export function problemSentences(
  entry: Pick<ImportEntryStatus, "state" | "reason" | "changedAfterUpload">,
): string[] {
  const sentences: string[] = [];
  if (entry.state === "failed" || (entry.reason && IMPORT_REASON_NEEDS_LOOK[entry.reason]))
    sentences.push(failureSentence(entry.reason));
  if (entry.changedAfterUpload) sentences.push(t`Edited after upload`);
  return sentences;
}
export function refusalSentence(code: ImportRefusalCode | null): string {
  switch (code) {
    case "too_many_files":
    case "too_many_nodes":
      return t`Too many files`;
    case "import_too_large":
    case "manifest_too_large":
    case "import_request_too_large":
      return t`Too large`;
    case "too_many_open_imports":
      return t`Too many imports`;
    case "path_too_long":
    case "path_too_deep":
      return t`Path too long`;
    case "selection_mismatch":
      return t`Selection changed`;
    case "destination_not_found":
    case "destination_invalid":
      return t`Folder not found`;
    case "export_marker_invalid":
    case "export_marker_root":
      return t`Can't read export`;
    default:
      return t`Couldn't import`;
  }
}
