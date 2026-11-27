import { createContext, useContext } from "react";
import type { ProjectDocumentLiveOpener } from "./project-document-live-opener";

export const ProjectDocumentLiveOpenerContext = createContext<ProjectDocumentLiveOpener | null>(
  null,
);

export function useProjectDocumentLiveOpener(): ProjectDocumentLiveOpener {
  const opener = useContext(ProjectDocumentLiveOpenerContext);
  if (!opener) throw new Error("AccountFeatureComposition is required");
  return opener;
}
