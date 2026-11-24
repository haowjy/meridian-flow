import {
  type ContextEntryValidationError,
  validateContextEntryName,
  validateContextEntryPath,
} from "@meridian/contracts/context-entry-validation";
import { createError } from "nitro/h3";

function validationError(field: string, error: ContextEntryValidationError): never {
  throw createError({
    statusCode: 400,
    message: `Invalid \`${field}\`: ${error.reason}`,
    data: { field, reason: error.reason, segment: error.segment },
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
