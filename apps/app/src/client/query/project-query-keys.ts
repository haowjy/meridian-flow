/**
 * project-query-keys — the canonical React Query key factory for project-scoped
 * data (list, detail, threads, works, preferences, context tree). Single source of key
 * shapes so reads, writes, and invalidations stay consistent.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";

export function isProjectContextTreeKey(queryKey: readonly unknown[], projectId: string): boolean {
  return (
    (queryKey.length === 5 || queryKey.length === 6) &&
    queryKey[0] === "projects" &&
    queryKey[1] === projectId &&
    queryKey[2] === "context" &&
    queryKey[4] !== "read" &&
    queryKey[queryKey.length - 1] === "tree"
  );
}

export const projectQueryKeys = {
  all: ["projects"] as const,
  list: ["projects", "list"] as const,
  detail: (projectId: string) => ["projects", "detail", projectId] as const,
  threads: (projectId: string) => ["projects", projectId, "threads"] as const,
  works: (projectId: string) => ["projects", projectId, "works"] as const,
  workDrafts: (projectId: string, workId: string) =>
    ["projects", projectId, "works", workId, "drafts"] as const,
  workDraftPreview: (projectId: string, workId: string, documentId: string, draftId?: string) =>
    [
      "projects",
      projectId,
      "works",
      workId,
      "documents",
      documentId,
      "draft",
      draftId ?? null,
    ] as const,
  preferences: (projectId: string) => ["projects", projectId, "preferences"] as const,
  contextTree: (projectId: string, scheme: ProjectContextTreeScheme, workId?: string | null) =>
    isWorkScopedProjectContextScheme(scheme) && workId
      ? (["projects", projectId, "context", scheme, workId, "tree"] as const)
      : (["projects", projectId, "context", scheme, "tree"] as const),
  agents: (projectId: string) => ["projects", projectId, "agents"] as const,
  library: (projectId: string) => ["projects", projectId, "library"] as const,
  agentDefinition: (projectId: string, slug: string) =>
    ["projects", projectId, "agents", slug, "definition"] as const,
  agentDefinitionRevisions: (projectId: string, slug: string) =>
    ["projects", projectId, "agents", slug, "revisions"] as const,
  skillDefinition: (projectId: string, slug: string) =>
    ["projects", projectId, "skills", slug, "definition"] as const,
  skillDefinitionRevisions: (projectId: string, slug: string) =>
    ["projects", projectId, "skills", slug, "revisions"] as const,
  results: (projectId: string) => ["projects", projectId, "results"] as const,
  resultSignedUrl: (projectId: string, resultId: string) =>
    ["projects", projectId, "results", resultId, "signed-url"] as const,
};
