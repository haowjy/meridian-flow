// Defines internal write-tool result envelopes beneath the public WriteOutcome API.
import type { WriteCommand, WriteStatus } from "./types.js";

export interface InternalWriteResult {
  status: WriteStatus;
  text: string;
  writeId?: string;
}

export function documentNotFound(
  commandName: WriteCommand["command"],
  filePath: string,
): InternalWriteResult {
  if (commandName === "view") {
    return status(
      "document_not_found",
      `File not found. Check the path, or use write(command="create", file="${filePath}") to make a new one.`,
    );
  }
  return status("document_not_found", "File not found. View the project to find the right path.");
}

export function isInternalWriteResult(value: unknown): value is InternalWriteResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "text" in value &&
    typeof (value as InternalWriteResult).text === "string"
  );
}

function status(code: WriteStatus, message?: string): InternalWriteResult {
  return {
    status: code,
    text: message ? `status: ${code}\n\n${message}` : `status: ${code}`,
  };
}
