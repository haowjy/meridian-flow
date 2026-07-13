/** Cached client-side suggestions composed across the project's context trees. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import {
  type FileSuggestion,
  type FileSuggestionKind,
  flattenFileSuggestionTrees,
  matchFileSuggestions,
} from "./file-suggestions";

type Options = {
  schemes: readonly ProjectContextTreeScheme[];
  kinds: readonly FileSuggestionKind[];
  activeThreadId: string | null;
};

export function useFileSuggestions(
  projectId: string,
  query: string,
  options: Options,
): { suggestions: FileSuggestion[]; isFetching: boolean; isError: boolean } {
  const enabled = (scheme: ProjectContextTreeScheme) => options.schemes.includes(scheme);
  const manuscript = useProjectContextTree(projectId, "manuscript", {
    enabled: enabled("manuscript"),
    activeThreadId: options.activeThreadId,
  });
  const kb = useProjectContextTree(projectId, "kb", {
    enabled: enabled("kb"),
    activeThreadId: options.activeThreadId,
  });
  const user = useProjectContextTree(projectId, "user", {
    enabled: enabled("user"),
    activeThreadId: options.activeThreadId,
  });
  const scratch = useProjectContextTree(projectId, "scratch", {
    enabled: enabled("scratch"),
    activeThreadId: options.activeThreadId,
  });
  const uploads = useProjectContextTree(projectId, "uploads", {
    enabled: enabled("uploads"),
    activeThreadId: options.activeThreadId,
  });
  const results = useMemo(
    () => [
      { scheme: "manuscript" as const, ...manuscript },
      { scheme: "kb" as const, ...kb },
      { scheme: "user" as const, ...user },
      { scheme: "scratch" as const, ...scratch },
      { scheme: "uploads" as const, ...uploads },
    ],
    [manuscript, kb, user, scratch, uploads],
  );

  const suggestions = useMemo(() => {
    const trees = results.flatMap(({ scheme, tree }) => (tree ? [{ scheme, tree }] : []));
    return matchFileSuggestions(flattenFileSuggestionTrees(trees), query, options);
  }, [results, query, options]);

  const allowedResults = results.filter(({ scheme }) => enabled(scheme));
  return {
    suggestions,
    isFetching: allowedResults.some(({ isFetching }) => isFetching),
    isError: allowedResults.some(({ isError }) => isError),
  };
}
