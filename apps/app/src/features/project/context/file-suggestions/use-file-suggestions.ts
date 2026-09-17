/** Cached client-side suggestions composed across the project's context trees. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { contextCatalogScope, useContextCatalogScope } from "@/client/query/useContextCatalog";
import {
  catalogFileSuggestions,
  type FileSuggestion,
  type FileSuggestionKind,
  matchFileSuggestions,
} from "./file-suggestions";

type Options = {
  schemes: readonly ProjectContextTreeScheme[];
  kinds: readonly FileSuggestionKind[];
  workId: string | null;
};

export function useFileSuggestions(
  projectId: string,
  query: string,
  options: Options,
): { suggestions: FileSuggestion[]; isFetching: boolean; isError: boolean } {
  const manuscriptScope = contextCatalogScope(projectId, "manuscript", options.workId);
  const userScope = contextCatalogScope(projectId, "user", options.workId);
  const scratchScope = contextCatalogScope(projectId, "scratch", options.workId);
  const project = useContextCatalogScope(
    projectId,
    manuscriptScope ?? { kind: "project", projectId },
    manuscriptScope != null &&
      options.schemes.some((scheme) => scheme === "manuscript" || scheme === "kb"),
  );
  const user = useContextCatalogScope(
    projectId,
    userScope ?? { kind: "user", userId: "self" },
    userScope != null && options.schemes.includes("user"),
  );
  const current = useContextCatalogScope(
    projectId,
    scratchScope ?? { kind: "project", projectId },
    scratchScope != null &&
      options.schemes.some((scheme) => scheme === "scratch" || scheme === "uploads"),
  );
  const suggestions = useMemo(() => {
    const entries = catalogFileSuggestions(
      [project.data, user.data, current.data].filter((view) => view !== undefined),
    );
    return matchFileSuggestions(entries, query, options);
  }, [project.data, user.data, current.data, query, options]);

  const allowedResults = [project, user, current];
  return {
    suggestions,
    isFetching: allowedResults.some(({ isFetching }) => isFetching),
    isError: allowedResults.some(({ isError }) => isError),
  };
}
