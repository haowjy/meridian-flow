/**
 * One clearing rule for Work metadata, shared by the model's `work` tool, the
 * HTTP routes and the domain commands: text is trimmed, blank goal or status
 * text clears like null, and a name can never be blank.
 */

export const WORK_STATUS_MAX_LENGTH = 32;
export const INVALID_WORK_STATUS = Symbol("invalid_work_status");
export const INVALID_WORK_NAME = Symbol("invalid_work_name");

export const WORK_NAME_REQUIRED_MESSAGE = "Work name must be a non-empty string";
export const WORK_STATUS_INVALID_MESSAGE = `Work status must be one to three words and ${WORK_STATUS_MAX_LENGTH} characters or fewer`;

export function normalizeWorkName(raw: string): string | typeof INVALID_WORK_NAME {
  const name = raw.trim();
  return name || INVALID_WORK_NAME;
}

export function normalizeWorkGoal(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim() || null;
}

/** Whitespace collapses before the length and word limits apply. */
export function normalizeWorkStatus(
  raw: string | null,
): string | null | typeof INVALID_WORK_STATUS {
  if (raw === null) return null;
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length > WORK_STATUS_MAX_LENGTH || normalized.split(" ").length > 3) {
    return INVALID_WORK_STATUS;
  }
  return normalized;
}

/** Omitted fields stay omitted: on update they mean unchanged. */
export type WorkMetadataInput = {
  name?: string;
  goal?: string | null;
  status?: string | null;
};

export type WorkMetadataNormalization =
  | { ok: true; value: WorkMetadataInput }
  | { ok: false; field: "name" | "status"; message: string };

export function normalizeWorkMetadata(input: WorkMetadataInput): WorkMetadataNormalization {
  const name = input.name === undefined ? undefined : normalizeWorkName(input.name);
  if (name === INVALID_WORK_NAME) {
    return { ok: false, field: "name", message: WORK_NAME_REQUIRED_MESSAGE };
  }
  const status = input.status === undefined ? undefined : normalizeWorkStatus(input.status);
  if (status === INVALID_WORK_STATUS) {
    return { ok: false, field: "status", message: WORK_STATUS_INVALID_MESSAGE };
  }
  return {
    ok: true,
    value: {
      ...(name !== undefined ? { name } : {}),
      ...(input.goal !== undefined ? { goal: normalizeWorkGoal(input.goal) } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
}
