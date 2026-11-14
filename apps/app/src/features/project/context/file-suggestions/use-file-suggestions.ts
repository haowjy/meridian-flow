/** Every folder and file across the project's trees, in tree order, read from the replay. */
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useMemo } from "react";
import { useProjectTreeViews } from "@/client/query/useProjectTree";
import { type FileSuggestion, treeFileSuggestions } from "./file-suggestions";

export function useFileSuggestions(
  projectId: string,
  schemes: readonly ProjectContextTreeScheme[],
  /** Whose Scratch and Uploads the suggestions list: the document's own owner. */
  owner: ContextOwner,
): FileSuggestion[] {
  const { workId, rootThreadId, chatThreadId } = owner;
  const schemeKey = schemes.join(",");
  const keyedSchemes = useMemo(
    () => schemeKey.split(",") as ProjectContextTreeScheme[],
    [schemeKey],
  );
  const views = useProjectTreeViews(projectId, keyedSchemes, {
    workId,
    rootThreadId,
    chatId: chatThreadId,
  });
  return useMemo(
    () =>
      treeFileSuggestions(
        keyedSchemes.flatMap((scheme) => {
          const tree = views[scheme].tree;
          return tree ? [{ scheme, tree }] : [];
        }),
      ),
    [views, keyedSchemes],
  );
}
