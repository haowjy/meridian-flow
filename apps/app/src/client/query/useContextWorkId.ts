/**
 * Resolves the work ID used for work-scoped context browse APIs (`work`, `uploads`).
 * Uses only the active thread's bound work — no arbitrary project-work fallback.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";

import { useProjectThreads } from "./useProjectThreads";

export function useContextWorkId(projectId: string, activeThreadId: string | null): string | null {
  const { threads } = useProjectThreads(projectId);

  return useMemo(() => {
    if (!activeThreadId || !threads) return null;
    const thread = threads.find((candidate) => candidate.id === activeThreadId);
    return thread?.workId ?? null;
  }, [activeThreadId, threads]);
}

export function contextRequestOptionsForScheme(
  scheme: ProjectContextTreeScheme,
  workId: string | null,
): { workId?: string } | undefined {
  if (!isWorkScopedProjectContextScheme(scheme) || !workId) return undefined;
  return { workId };
}
