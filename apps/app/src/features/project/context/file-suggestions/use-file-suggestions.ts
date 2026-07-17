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
  workId?: string | null;
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
    workId: options.workId,
  });
  const uploads = useProjectContextTree(projectId, "uploads", {
    enabled: enabled("uploads"),
    activeThreadId: options.activeThreadId,
    workId: options.workId,
  });
  // Memoize from the stable `.tree` references (query wrapper objects get a
  // fresh identity every render) plus the options object, which callers must
  // keep referentially stable — a per-render options literal silently defeats
  // this cache and reruns the full flatten+match pipeline on every keystroke.
  const suggestions = useMemo(() => {
    const trees = [
      { scheme: "manuscript" as const, tree: manuscript.tree },
      { scheme: "kb" as const, tree: kb.tree },
      { scheme: "user" as const, tree: user.tree },
      { scheme: "scratch" as const, tree: scratch.tree },
      { scheme: "uploads" as const, tree: uploads.tree },
    ].flatMap(({ scheme, tree }) => (tree ? [{ scheme, tree }] : []));
    return matchFileSuggestions(flattenFileSuggestionTrees(trees), query, options);
  }, [manuscript.tree, kb.tree, user.tree, scratch.tree, uploads.tree, query, options]);

  const allowedResults = [
    { scheme: "manuscript" as const, ...manuscript },
    { scheme: "kb" as const, ...kb },
    { scheme: "user" as const, ...user },
    { scheme: "scratch" as const, ...scratch },
    { scheme: "uploads" as const, ...uploads },
  ].filter(({ scheme }) => enabled(scheme));
  return {
    suggestions,
    isFetching: allowedResults.some(({ isFetching }) => isFetching),
    isError: allowedResults.some(({ isError }) => isError),
  };
}
