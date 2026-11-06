import type { ContextEntryValidationError } from "@meridian/contracts/context-entry-validation";
import type { ContextError } from "../ports/context-port.js";

/** The refusal for a path or name that fails validation, worded one way wherever it is checked. */
export function invalidEntryError(
  uri: string,
  validation: ContextEntryValidationError,
): ContextError {
  return {
    code: "invalid_uri",
    uri,
    reason:
      validation.reason === "name/reserved-authority-qualifier"
        ? `File and folder names cannot begin with "@" or "~" (${validation.segment ?? "unknown"})`
        : `Invalid context path (${validation.reason})`,
  };
}
