/** Public projection and opaque server capability for exact Work authority. */

import type { WorkId } from "../ids.js";
import type { WorkSlug } from "./work-slug.js";
import { decodeWorkSlug } from "./work-slug.js";

export type WorkAuthorityDto = {
  kind: "work";
  workId: WorkId;
  workSlug: WorkSlug;
};

declare const resolvedWorkAuthorityBrand: unique symbol;

/** Minted only after exact, same-project, non-deleted Work resolution. */
export type ResolvedWorkAuthority = WorkAuthorityDto & {
  readonly [resolvedWorkAuthorityBrand]: "ResolvedWorkAuthority";
};

/** Validate the JSON projection without granting stable server authority. */
export function decodeWorkAuthorityDto(value: unknown): WorkAuthorityDto | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const workSlug = decodeWorkSlug(candidate.workSlug);
  return candidate.kind === "work" && typeof candidate.workId === "string" && workSlug
    ? { kind: "work", workId: candidate.workId, workSlug }
    : null;
}
