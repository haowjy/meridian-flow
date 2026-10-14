/** Failure reasons and refusals as sentences. The server sends codes; the app writes the words. */
import { plural, t } from "@lingui/core/macro";
import type { ImportEntryReason, ImportRefusalCode } from "@meridian/contracts";
import type { ImportRunInfo } from "@/client/query/context-catalog-projection";

const serverError = () => t`Something went wrong on our side. Try again.`;

/** `entry.reason` for a failed or deleted file. No reason reads as a server error. */
export function failureSentence(reason: ImportEntryReason | null | undefined): string {
  switch (reason) {
    case "conversion_failed":
      return t`This Word document couldn't be read.`;
    case "upload_failed":
      return t`The upload didn't finish.`;
    case "changed_since_chosen":
      return t`The file changed after you chose it.`;
    case "too_large":
      return t`It's over 50 MB.`;
    case "edited_before_arrival":
      return t`You wrote here before the imported text arrived.`;
    case "deleted_before_arrival":
      return t`It was deleted before its text arrived.`;
    case "folder_deleted":
      return t`Its folder was deleted before it arrived.`;
    // Skip reasons never mark a failed file; a server error is the honest reading.
    case "obsidian_canvas":
    case "trash":
    case "hidden":
    case "unreadable":
    case "export_works":
    case "server_error":
    case null:
    case undefined:
      return serverError();
    default:
      return unhandled(reason);
  }
}

/** Why an import did not start, from the server's refusal code. */
export function refusalSentence(code: ImportRefusalCode | null): string {
  switch (code) {
    case "too_many_files":
    case "too_many_nodes":
      return t`That's more files than one import can hold. Import fewer at a time.`;
    case "import_too_large":
    case "manifest_too_large":
    case "import_request_too_large":
      return t`That's more than one import can hold. Import less at a time.`;
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
    case "import_busy":
      return t`Too many files are being sent at once. Try again in a moment.`;
    // The app builds every manifest and request itself, so these are our faults, not the
    // writer's: the selection was fine. Unanswered requests (no code) read the same.
    case "import_not_found":
    case "entry_not_found":
    case "import_not_ready":
    case "import_not_finished":
    case "manifest_invalid":
    case "duplicate_root_id":
    case "duplicate_entry_id":
    case "duplicate_selection_path":
    case "invalid_root_path":
    case "invalid_file_root":
    case "unreadable_root_has_entries":
    case "sniff_required":
    case "sniff_length":
    case "invalid_import_file_parts":
    case "duplicate_import_entry_id":
    case "too_many_parts":
    case "invalid_import_version":
    case "open_filter_required":
    case null:
      return serverError();
    default:
      return unhandled(code);
  }
}

/** A code the contract added without copy here fails to compile, not to read. */
function unhandled(code: never): string {
  void code;
  return serverError();
}

/** What a running import's mark says, on hover and at the top of its menu. */
export function runSentence(run: ImportRunInfo): string {
  const progress = t`${run.arrived} of ${run.total} files have arrived.`;
  switch (run.kind) {
    case "sending":
      return t`Sending your files. ${progress}`;
    case "stopping":
      return t`Stopping the import.`;
    case "interrupted":
      return t`The import paused. ${progress} Continue to send the rest.`;
    case "failed":
      return plural(run.failed, {
        one: "# file didn't import.",
        other: "# files didn't import.",
      });
  }
}
