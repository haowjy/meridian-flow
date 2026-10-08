/** Localized namespace refusals from typed causes, never server prose. */
import { t } from "@lingui/core/macro";
import { documentLocationPath } from "./document-display-name";

export function namespaceRefusalCopy(
  commandName: string,
  reason: unknown,
  path: string,
): string | null {
  const command =
    commandName === "move"
      ? t`move`
      : commandName === "delete"
        ? t`delete`
        : commandName === "undo"
          ? t`undo`
          : commandName === "redo"
            ? t`redo`
            : null;
  if (!command) return null;
  const place = documentLocationPath(path, true);
  switch (reason) {
    case "location_taken":
      return t`Can't ${command}: ${place} is already taken. Choose another location.`;
    case "folder_missing":
      return t`Can't ${command}: the document's original folder is gone.`;
    case "source_is_folder":
      return t`Can't ${command}: this is a folder. Choose a document instead.`;
    case "destination_is_folder":
      return t`Can't ${command}: the destination is a folder. Include the document's filename.`;
    case "path_required":
      return t`Can't ${command}: the destination needs a filename.`;
    case "file_type_conversion":
      return t`Can't ${command}: renaming a document does not convert its file type. Keep its current extension.`;
    case "document_type_conversion":
      return t`Can't ${command}: that extension requires a different document type. Keep its current extension.`;
    case "stale_location":
      return t`Can't ${command}: the document or destination changed. Check their current locations, then try again.`;
    case "already_at_destination":
      return t`Can't ${command}: the document is already at that location.`;
    case "already_reversed":
      return t`Can't ${command}: that change was already reversed.`;
    case "document_missing":
      return t`Can't ${command}: the document no longer exists at that location.`;
    case "invalid_path":
      return t`Can't ${command}: the document path is not valid. Check the location, then try again.`;
    case "work_archived":
      return t`Can't ${command}: the document's Work is archived. Unarchive the Work, then try again.`;
    case "work_deleted":
    case "work_missing":
      return t`Can't ${command}: that Work is unavailable. Choose an available Work.`;
    case "uploads_read_only":
      return t`Can't ${command}: documents in Uploads are read-only.`;
    case "agent_read_only":
      return t`Can't ${command}: the agent has read-only permission here.`;
    case "action_denied":
      return t`Can't ${command}: you don't have permission to change this document here.`;
    case "invalid_operation":
      return t`Can't ${command}: this location does not support the change. Check the source and destination.`;
    case "request_failed":
      return t`Can't ${command}: the request failed. Try again.`;
    default:
      return null;
  }
}
