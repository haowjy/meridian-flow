/** Failure reasons and refusals as sentences. The server sends codes; the app writes the words. */
import { t } from "@lingui/core/macro";

/** `entry.reason` for a failed or deleted file. Anything unrecognized is a server error. */
export function failureSentence(reason: string | null | undefined): string {
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
    default:
      return t`Something went wrong on our side. Try again.`;
  }
}

/** Why an import did not start, from the server's refusal code. */
export function refusalSentence(code: string | null): string {
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
    default:
      return t`Something went wrong on our side. Try again.`;
  }
}
