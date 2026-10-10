/** Request options for context schemes with an explicit owner: a Work, or a lineage's Scratch. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

export type { ContextOwner };

/** The owner flattened for an HTTP request: a Work-scoped scheme needs one. */
export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner,
):
  | { workId: string; rootThreadId?: undefined }
  | { workId?: undefined; rootThreadId: string }
  | undefined {
  if (!isWorkScopedProjectContextScheme(scheme)) return undefined;
  if (scheme === "scratch" && owner.rootThreadId) return { rootThreadId: owner.rootThreadId };
  if (!owner.workId) throw new Error("Work-scoped reads require a Work row id");
  return { workId: owner.workId };
}
