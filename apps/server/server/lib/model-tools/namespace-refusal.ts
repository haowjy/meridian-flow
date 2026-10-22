/**
 * Why a `move` or `delete` didn't run, as a typed cause, and the sentence the model reads for
 * it: "Can't ‹command› ‹path›: ‹cause›. ‹next step›." Causes come from typed context errors,
 * never from parsing storage diagnostics.
 */
import type { NamespaceCommandName, NamespaceRefusal } from "@meridian/agent-edit/integration";
import { modelResult } from "@meridian/agent-edit/integration";
import type { ContextError } from "@meridian/contracts/protocol";
import { contextErrorMessage, type WriteToolErrorOutput, writeToolError } from "./tool-context.js";

/** The paths a refusal names: the document it acts on and, for a move, where it was going. */
export type NamespaceRefusalPaths = { path: string; destination?: string };

function sentence(
  command: NamespaceCommandName,
  reason: NamespaceRefusal,
  { path, destination }: NamespaceRefusalPaths,
): string {
  const lead = `Can't ${command} ${path}`;
  const to = destination ?? path;
  switch (reason) {
    case "source_is_folder":
      return `${lead}: it is a folder. Use \`ls\` to find the document, then retry with its path.`;
    case "document_unresolved":
      return `${lead}: the document couldn't be resolved. Check its path with \`ls\` and try again. If it still fails, tell the user the change couldn't be made.`;
    case "location_taken":
      return `Can't move to ${to}: that path is already taken. Choose another path.`;
    case "destination_missing":
      return `Can't move to ${to}: its folder doesn't exist. Use \`ls\` to find the folder, then retry.`;
    case "stale_location":
      return `Can't ${command}: the document or destination changed during the operation. Check the paths with \`ls\`, then retry.`;
    case "already_at_destination":
      return `The document is already at ${to}.`;
    case "file_type_conversion":
      return `Can't move ${path} to ${to}: renaming it won't convert it to another file type. Keep its current extension.`;
    case "document_type_conversion":
      return `Can't move ${path} to ${to}: that extension requires a different document type. Keep its current extension.`;
    case "unsupported":
      return `${lead}: this location doesn't support the change. Check the source and destination with \`ls\` before retrying.`;
  }
}

/** A refusal with its typed cause on the result, for the chat's own wording. */
export function namespaceRefusal(
  command: NamespaceCommandName,
  reason: NamespaceRefusal,
  paths: NamespaceRefusalPaths,
): WriteToolErrorOutput {
  return {
    isError: true,
    output: modelResult({
      command,
      status: "invalid_write",
      payload: {
        path: paths.destination ?? paths.path,
        refusal: reason,
        message: sentence(command, reason, paths),
      },
    }),
  };
}

/** A context error from the move or delete itself, in the command's terms. */
export function namespaceContextRefusal(
  command: NamespaceCommandName,
  error: ContextError,
  paths: NamespaceRefusalPaths,
): WriteToolErrorOutput {
  switch (error.code) {
    case "conflict":
      return namespaceRefusal(command, "location_taken", paths);
    case "destination_missing":
      return namespaceRefusal(command, "destination_missing", paths);
    case "stale_source":
    case "stale_target":
    case "operation_mismatch":
      return namespaceRefusal(command, "stale_location", paths);
    case "invalid_operation":
      return error.reason === "file_type_conversion" || error.reason === "document_type_conversion"
        ? namespaceRefusal(command, error.reason, paths)
        : namespaceRefusal(command, "unsupported", paths);
    default:
      // Not found, an archived or missing Work, a bad name, an I/O failure: the port's own words.
      return writeToolError(command, contextErrorMessage(error), "invalid_write", {
        path: paths.path,
      });
  }
}
