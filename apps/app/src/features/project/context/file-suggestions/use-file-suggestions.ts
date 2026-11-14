/** Suggestions composed across the project's trees, read from the replay. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import {
  type FileSuggestion,
  type FileSuggestionKind,
  matchFileSuggestions,
  treeFileSuggestions,
} from "./file-suggestions";

type Options = {
  schemes: readonly ProjectContextTreeScheme[];
  kinds: readonly FileSuggestionKind[];
  /** Whose Scratch and Uploads the suggestions list: the document's own owner. */
  owner: ContextOwner;
};

export function useFileSuggestions(
  projectId: string,
  query: string,
  options: Options,
): { suggestions: FileSuggestion[] } {
  const { workId, rootThreadId, chatThreadId } = options.owner;
  const schemeKey = options.schemes.join(",");
  const schemes = useMemo(() => schemeKey.split(",") as Options["schemes"], [schemeKey]);
  const views = useProjectTreeViews(projectId, schemes, {
    workId,
    rootThreadId,
    chatId: chatThreadId,
  });
  const suggestions = useMemo(() => {
    const trees = schemes.flatMap((scheme) => {
      const tree = views[scheme].tree;
      return tree ? [{ scheme, tree }] : [];
    });
    return matchFileSuggestions(treeFileSuggestions(trees), query, options);
  }, [views, schemes, query, options]);
  return { suggestions };
}
