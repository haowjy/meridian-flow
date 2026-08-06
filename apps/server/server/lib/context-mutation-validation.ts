/** Canonical reason-coded validation for writer-facing context mutations. */

import {
  type ContextEntryValidationError,
  validateContextEntryName,
  validateContextEntryPath,
} from "@meridian/contracts/context-entry-validation";
import { createError } from "nitro/h3";

function validationError(field: string, error: ContextEntryValidationError): never {
  const message =
    error.reason === "name/reserved-authority-qualifier"
      ? `Invalid \`${field}\`: names beginning with '@' are reserved for Work authority qualifiers`
      : `Invalid \`${field}\`: ${error.reason}`;
  throw createError({
    statusCode: 400,
    message,
    data: { field, reason: error.reason, segment: error.segment, character: error.character },
  });
}

export function parseContextMutationPath(
  raw: unknown,
  field: string,
  options: { allowRoot?: boolean } = {},
): string {
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, message: `\`${field}\` is required` });
  }
  // Context locations are rooted in client state, while the shared validator
  // returns the scheme-relative form consumed by ContextPort URIs.
  const relativePath = raw.startsWith("/") ? raw.slice(1) : raw;
  const result = validateContextEntryPath(relativePath, { allowRoot: options.allowRoot });
  if (!result.ok) validationError(field, result);
  return result.value;
}

export function parseContextMutationName(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw createError({ statusCode: 400, message: `\`${field}\` is required` });
  }
  const result = validateContextEntryName(raw);
  if (!result.ok) validationError(field, result);
  return result.value;
}
