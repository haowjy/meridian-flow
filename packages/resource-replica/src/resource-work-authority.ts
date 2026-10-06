/** Checked Work construction at command boundaries and one durable URI authority rule. */
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { ResourceWorkAuthority } from "./resource-records";

/** The locked row is separate from named Works in the project's authoritative snapshot. */
export function resourceWorkAuthorityFor(
  workId: string,
  snapshot: { works: readonly { id: string; slug: string | null }[]; noWork: { id: string } },
): ResourceWorkAuthority {
  if (workId === snapshot.noWork.id) return { workId, workSlug: null };
  const work = snapshot.works.find((candidate) => candidate.id === workId);
  if (!work?.slug) throw new Error("The destination Work has no known named authority");
  return { workId: work.id, workSlug: work.slug };
}

/** Journal identity was checked against a Works snapshot or asserted by a scoped server catalog. */
export function resourceContextAuthority(
  scheme: ProjectContextTreeScheme,
  work: { workId: string | null; workSlug?: string | null },
): { kind: "contextual" } | { kind: "none" } | { kind: "work"; workSlug: string } {
  if (!isWorkScopedProjectContextScheme(scheme)) return { kind: "contextual" };
  if (!work.workId || work.workSlug === undefined)
    throw new Error("Work-scoped authority requires a known Work identity");
  return work.workSlug === null ? { kind: "none" } : { kind: "work", workSlug: work.workSlug };
}
