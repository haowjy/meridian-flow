/** Namespace refusal facts and model copy; no parsing of storage diagnostics. */
import type { DocumentCommandName } from "@meridian/agent-edit/integration";
import type { ContextError, NamespaceRefusalReason } from "@meridian/contracts/protocol";
import { writeToolError } from "./tool-context.js";

export function namespaceRefusal(
  command: DocumentCommandName,
  path: string,
  reason: NamespaceRefusalReason,
) {
  const lead = `Can't ${command} ${path}`;
  const message = (() => {
    switch (reason) {
      case "location_taken":
        return `${lead}: that location is already taken. Choose another path, or move or rename the item there first.`;
      case "folder_missing":
        return `${lead}: the document's original folder is gone. Tell the user it can't be restored here.`;
      case "source_is_folder":
        return `${lead}: it is a folder. Use \`ls\` to find the document, then retry with its path.`;
      case "destination_is_folder":
        return `${lead}: the destination is a folder. Give a document path inside it, including the filename.`;
      case "path_required":
        return `${lead}: the destination needs a filename. Give the full document path, then retry.`;
      case "file_type_conversion":
        return `${lead}: renaming a document does not convert its file type. Keep its current extension.`;
      case "document_type_conversion":
        return `${lead}: that extension requires a different document type. Keep its current extension.`;
      case "stale_location":
        return `${lead}: the document or destination changed during the operation. Check the paths with \`ls\`, then retry.`;
      case "already_at_destination":
        return `${lead}: the document is already there. No move is needed.`;
      case "already_reversed":
        return `${lead}: that change was already reversed. Check its current state before trying again.`;
      case "document_missing":
        return `${lead}: no document exists there. Use \`ls\` to check the path, then retry.`;
      case "invalid_path":
        return `${lead}: the path is not valid. Use \`ls\` to check the address, then retry.`;
      case "work_deleted":
      case "work_missing":
        return `${lead}: that Work is unavailable. Use \`work list\` to choose an available Work.`;
      case "invalid_operation":
        return `${lead}: this location does not support the change. Check the source and destination with \`ls\` before retrying.`;
      case "request_failed":
        return `${lead}: the request failed. Try again.`;
    }
  })();
  return writeToolError(command, message, "invalid_write", { path, reason });
}

export function namespaceContextRefusal(command: DocumentCommandName, error: ContextError) {
  switch (error.code) {
    case "conflict":
      return namespaceRefusal(command, error.uri, "location_taken");
    case "not_found":
      return namespaceRefusal(command, error.uri, "document_missing");
    case "stale_source":
    case "stale_target":
      return namespaceRefusal(command, error.uri, "stale_location");
    case "invalid_operation":
      return namespaceRefusal(command, error.uri, error.reason ?? "invalid_operation");
    case "invalid_uri":
      return namespaceRefusal(command, error.uri, "invalid_path");
    case "context_unavailable":
      if (error.reason !== "work_archived")
        return namespaceRefusal(command, error.uri, error.reason);
      return writeToolError(
        command,
        `Can't ${command}: the document's Work is archived. Unarchive the Work, then retry.`,
        "permission_denied",
        { path: error.uri, reason: "work_archived" },
      );
    case "permission_denied": {
      if (error.reason === "not_found")
        return namespaceRefusal(command, error.uri, "document_missing");
      const reason = error.reason ?? "action_denied";
      const message =
        reason === "work_archived"
          ? `Can't ${command}: the document's Work is archived. Unarchive the Work, then retry.`
          : reason === "uploads_read_only"
            ? `Can't ${command}: documents in uploads:// are read-only. Tell the user the change wasn't made.`
            : reason === "agent_read_only"
              ? `Can't ${command}: your permission is read, so you can change only this chat's scratch://. Tell the user the change wasn't made.`
              : `Can't ${command}: you don't have permission to change this document here. Tell the user the change wasn't made.`;
      return writeToolError(command, message, "permission_denied", { path: error.uri, reason });
    }
    case "operation_mismatch":
      return namespaceRefusal(command, error.uri, "stale_location");
    case "io_error":
      return namespaceRefusal(command, error.uri, "request_failed");
  }
}
