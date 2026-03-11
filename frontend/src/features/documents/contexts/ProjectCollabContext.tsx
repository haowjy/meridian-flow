import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import {
  DocumentSessionManager,
  resolveDocumentAccessToken,
} from "@/core/cm6-collab/sync/DocumentSessionManager";

import {
  useProjectCollab,
  type ProjectCollabTransport,
} from "../hooks/useProjectCollab";

export interface ProjectCollabContextValue {
  projectCollab: ProjectCollabTransport;
  documentSessionManager: DocumentSessionManager;
}

const ProjectCollabContext = createContext<ProjectCollabContextValue | null>(
  null,
);

interface ProjectCollabProviderProps {
  projectId: string;
  children: ReactNode;
}

export function ProjectCollabProvider({
  projectId,
  children,
}: ProjectCollabProviderProps) {
  const projectCollab = useProjectCollab(projectId);
  const documentSessionManager = useMemo(() => {
    return new DocumentSessionManager(resolveDocumentAccessToken);
  }, []);

  useEffect(() => {
    // React StrictMode runs mount cleanup once before the committed mount.
    // Re-enable the memoized manager so downstream hooks can reacquire sessions.
    documentSessionManager.revive();

    return () => {
      documentSessionManager.destroy();
    };
  }, [documentSessionManager]);

  return (
    <ProjectCollabContext.Provider
      value={{
        projectCollab,
        documentSessionManager,
      }}
    >
      {children}
    </ProjectCollabContext.Provider>
  );
}

export function useProjectCollabContext(): ProjectCollabContextValue {
  const context = useContext(ProjectCollabContext);
  if (context == null) {
    throw new Error(
      "useProjectCollabContext must be used within a ProjectCollabProvider",
    );
  }
  return context;
}
