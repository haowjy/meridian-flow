// @ts-nocheck
/**
 * workbench-query-keys — the canonical React Query key factory for workbench-scoped
 * data (list, detail, threads, works, preferences, context tree). Single source of key
 * shapes so reads, writes, and invalidations stay consistent.
 */
import type { WorkbenchContextTreeScheme } from "@meridian/contracts/protocol";

export const workbenchQueryKeys = {
  all: ["workbenches"] as const,
  list: ["workbenches", "list"] as const,
  detail: (workbenchId: string) => ["workbenches", "detail", workbenchId] as const,
  threads: (workbenchId: string) => ["workbenches", workbenchId, "threads"] as const,
  works: (workbenchId: string) => ["workbenches", workbenchId, "works"] as const,
  preferences: (workbenchId: string) => ["workbenches", workbenchId, "preferences"] as const,
  contextTree: (workbenchId: string, scheme: WorkbenchContextTreeScheme) =>
    ["workbenches", workbenchId, "context", scheme, "tree"] as const,
  agents: (workbenchId: string) => ["workbenches", workbenchId, "agents"] as const,
  results: (workbenchId: string) => ["workbenches", workbenchId, "results"] as const,
  resultSignedUrl: (workbenchId: string, resultId: string) =>
    ["workbenches", workbenchId, "results", resultId, "signed-url"] as const,
};
