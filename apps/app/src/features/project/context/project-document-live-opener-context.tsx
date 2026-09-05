/** React injection boundary for the immutable account's document opener. */
import { createContext, useContext } from "react";
import type { ProjectDocumentLiveOpener } from "./open-project-document";

export const ProjectDocumentLiveOpenerContext = createContext<ProjectDocumentLiveOpener | null>(
  null,
);

export function useProjectDocumentLiveOpener(): ProjectDocumentLiveOpener {
  const opener = useContext(ProjectDocumentLiveOpenerContext);
  if (!opener) throw new Error("AccountFeatureComposition is required");
  return opener;
}
