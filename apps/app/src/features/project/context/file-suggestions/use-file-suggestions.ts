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
  const project = useContextCatalogScope(
    projectId,
    contextCatalogScope(projectId, "manuscript", options.workId),
    options.schemes.some((scheme) => scheme === "manuscript" || scheme === "kb"),
  );
  const user = useContextCatalogScope(
    projectId,
    contextCatalogScope(projectId, "user", options.workId),
    options.schemes.includes("user"),
  );
  const current = useContextCatalogScope(
    projectId,
    contextCatalogScope(projectId, "scratch", options.workId),
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
