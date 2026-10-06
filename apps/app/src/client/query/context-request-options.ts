/** Request options for context schemes with explicit Editor Work ownership. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  workId: string | null | undefined,
): { workId?: string } | undefined {
  if (!isWorkScopedProjectContextScheme(scheme)) return undefined;
  if (!workId) throw new Error("Work-scoped reads require a Work row id");
  return { workId };
}
