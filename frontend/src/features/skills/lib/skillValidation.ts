/**
 * Skill name validation utilities.
 * Mirrors backend validation from backend/internal/service/skill/project_skill.go
 *
 * Rules:
 * - Allowed characters: a-z, A-Z, 0-9, hyphens (-)
 * - Must start and end with alphanumeric (not hyphen)
 * - Length: 1-50 characters
 * - Case-insensitive uniqueness (enforced by backend index)
 */

// Pattern: alphanumeric start/end, alphanumeric or hyphens in middle
// Single char version: just alphanumeric
// Multi char version: alphanumeric, then any combo of alphanumeric/hyphen, then alphanumeric
export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export const SKILL_NAME_MAX_LENGTH = 50;

// Reserved names that cannot be used for skills (used for routing)
export const RESERVED_SKILL_NAMES = ["new"] as const;

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Normalize user input for skill names.
 * Auto-transforms while preserving case:
 * - Spaces -> hyphens
 * - Strip invalid characters (keep a-zA-Z0-9-)
 * - Collapse consecutive hyphens
 */
export function normalizeSkillName(input: string): string {
  return input
    .replace(/\s+/g, "-") // spaces -> hyphens
    .replace(/[^a-zA-Z0-9-]/g, "") // strip invalid chars (keep case)
    .replace(/-+/g, "-"); // collapse multiple hyphens
}

/**
 * Validate a skill name.
 * Returns validation result with error message if invalid.
 */
export function validateSkillName(name: string): ValidationResult {
  if (!name) {
    return { valid: false, error: "Required" };
  }

  if (name.length > SKILL_NAME_MAX_LENGTH) {
    return { valid: false, error: `Max ${SKILL_NAME_MAX_LENGTH} characters` };
  }

  // Check for reserved names (case-insensitive)
  if (
    RESERVED_SKILL_NAMES.includes(
      name.toLowerCase() as (typeof RESERVED_SKILL_NAMES)[number],
    )
  ) {
    return { valid: false, error: `"${name}" is a reserved name` };
  }

  if (!SKILL_NAME_PATTERN.test(name)) {
    // Provide specific error for common issues
    if (name.startsWith("-") || name.endsWith("-")) {
      return { valid: false, error: "Cannot start or end with hyphen" };
    }
    return {
      valid: false,
      error: "Only letters, numbers, and hyphens allowed",
    };
  }

  return { valid: true };
}
