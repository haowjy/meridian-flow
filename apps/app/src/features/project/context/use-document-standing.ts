/** Where a document stands in its project's list, as a hook: re-read whenever the list changes. */
import { useEffect, useState } from "react";
import type { DocumentStanding } from "@/core/tree-list/standing";
import { useProjectStandings } from "./account-feature-context";

export function useDocumentStanding(projectId: string, documentId: string): DocumentStanding {
  const standings = useProjectStandings();
  const [standing, setStanding] = useState(() => standings.standing(projectId, documentId));
  useEffect(
    () => standings.watch(projectId, () => setStanding(standings.standing(projectId, documentId))),
    [standings, projectId, documentId],
  );
  return standing;
}
