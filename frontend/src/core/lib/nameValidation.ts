/**
 * Name validation utilities for folders and documents.
 * Matches backend validation rules from:
 * - backend/internal/service/docsystem/folder.go
 * - backend/internal/service/docsystem/document.go
 * - backend/internal/config/limits.go
 */

// Constants synced with backend
const RESERVED_ROOT_FOLDER_NAMES = [".meridian", ".session", ".agents"] as const;
const MAX_NAME_LENGTH = 255;

export type ValidationType = "folder" | "document";

interface ValidationOptions {
  type?: ValidationType;
  isRootLevel?: boolean;
  existingNames?: string[];
  currentName?: string; // For rename validation (exclude self from duplicate check)
  allowDuplicates?: boolean;
}

/**
 * Validates that name is not empty after trimming
 */
function validateNotEmpty(name: string): string | null {
  if (!name.trim()) {
    return "Name cannot be empty";
  }
  return null;
}

/**
 * Validates that name does not contain slashes
 * Matches backend regex: ^[^/]+$
 */
function validateNoSlashes(name: string): string | null {
  if (name.includes("/")) {
    return "Name cannot contain slashes";
  }
  return null;
}

/**
 * Validates that name does not exceed max length
 * Matches backend MaxFolderNameLength and MaxDocumentNameLength (255)
 */
function validateMaxLength(name: string): string | null {
  if (name.length > MAX_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * Validates that folder name is not reserved at root level
 * Only applies to folders at root level
 * Matches backend reservedRootFolderNames
 */
function validateNotReserved(
  name: string,
  options: Pick<ValidationOptions, "type" | "isRootLevel">,
): string | null {
  if (options.type === "folder" && options.isRootLevel) {
    const isReserved = RESERVED_ROOT_FOLDER_NAMES.some(
      (reserved) => reserved.toLowerCase() === name.toLowerCase(),
    );
    if (isReserved) {
      return `'${name}' is a reserved folder name and cannot be created at root level`;
    }
  }
  return null;
}

/**
 * Validates that name is not a duplicate
 * Case-insensitive comparison, excludes current name for renames
 */
function validateNotDuplicate(
  name: string,
  options: Pick<
    ValidationOptions,
    "existingNames" | "currentName" | "allowDuplicates"
  >,
): string | null {
  if (options.allowDuplicates) {
    return null;
  }

  const existingNames = options.existingNames ?? [];
  const currentName = options.currentName ?? "";

  const isDuplicate = existingNames.some(
    (existing) =>
      existing.toLowerCase() === name.toLowerCase() &&
      existing.toLowerCase() !== currentName.toLowerCase(),
  );

  if (isDuplicate) {
    return "A file or folder with this name already exists";
  }

  return null;
}

/**
 * Composite validator that runs all validation rules in order
 * Returns first error encountered, or null if all pass
 */
export function validateName(
  name: string,
  options: ValidationOptions = {},
): string | null {
  const trimmed = name.trim();

  // Run validators in order (fail fast)
  const error =
    validateNotEmpty(trimmed) ||
    validateNoSlashes(trimmed) ||
    validateMaxLength(trimmed) ||
    validateNotReserved(trimmed, options) ||
    validateNotDuplicate(trimmed, options);

  return error;
}
