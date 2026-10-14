/** The limits a picked or dropped selection must pass before an import starts. */
import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { formatBytes } from "./format-size";
import { IMPORT_FILE_LIMITS } from "./limits";
import { type Selection, selectionTotals } from "./selection";

/** Why this selection cannot be imported, as a sentence; null when it can go. */
export function refusalOf(
  selection: Selection,
  source: "folder" | "files" | "drop",
): string | null {
  const totals = selectionTotals(selection, IMPORT_FILE_LIMITS.fileBytes);
  if (totals.files === 0) {
    if (source === "folder") return t`That folder has no files to import.`;
    if (source === "files") return t`Those files can't be imported.`;
    return t`There are no files to import here.`;
  }
  if (totals.files > IMPORT_FILE_LIMITS.files) {
    const count = i18n.number(totals.files);
    const limit = i18n.number(IMPORT_FILE_LIMITS.files);
    return t`That's ${count} files. Import up to ${limit} at a time.`;
  }
  if (totals.bytes > IMPORT_FILE_LIMITS.totalBytes) {
    const size = formatBytes(totals.bytes);
    return t`That's ${size}. Import up to 2 GB at a time.`;
  }
  return null;
}
