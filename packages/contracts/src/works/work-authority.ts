/** Public projection and opaque server capability for exact Work authority. */

import type { WorkId } from "../ids.js";
import type { WorkSlug } from "./work-slug.js";
import { decodeWorkSlug } from "./work-slug.js";

export type WorkAuthorityDto = { workId: WorkId; workSlug: WorkSlug | null };

declare const resolvedWorkAuthorityBrand: unique symbol;

/** Minted only after exact, same-project, non-deleted Work resolution. */
export type ResolvedWorkAuthority = WorkAuthorityDto & {
  readonly [resolvedWorkAuthorityBrand]: "ResolvedWorkAuthority";
};

/** Validate the JSON projection without granting stable server authority. */
export function decodeWorkAuthorityDto(value: unknown): WorkAuthorityDto | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.workId !== "string") return null;
  if (candidate.workSlug === null) return { workId: candidate.workId, workSlug: null };
  const workSlug = decodeWorkSlug(candidate.workSlug);
  return workSlug ? { workId: candidate.workId, workSlug } : null;
}
