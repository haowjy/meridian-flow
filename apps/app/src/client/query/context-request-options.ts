/** Request options for context schemes with an explicit owner: a Work, or a lineage's Scratch. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

/**
 * Who holds a Work-capable document: a Work row id, or for Scratch a lineage
 * named by its first chat's id (a No Work chat's Scratch). Project schemes name
 * neither. At most one is set.
 */
export type ContextOwner = {
  workId?: string | null;
  rootThreadId?: string | null;
};

export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner,
): { workId?: string; rootThreadId?: string } | undefined {
  if (!isWorkScopedProjectContextScheme(scheme)) return undefined;
  if (scheme === "scratch" && owner.rootThreadId) return { rootThreadId: owner.rootThreadId };
  if (!owner.workId) throw new Error("Work-scoped reads require a Work row id");
  return { workId: owner.workId };
}
