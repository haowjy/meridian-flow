/** Request options for context schemes with explicit Editor Work ownership. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): { workId?: string } | undefined {
  if (!isWorkScopedProjectContextScheme(scheme) || !workId) return undefined;
  return { workId };
}
