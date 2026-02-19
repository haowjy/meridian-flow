import { createContext, useContext, type ReactNode } from "react";

import {
  useProjectCollab,
  type ProjectCollabTransport,
} from "../hooks/useProjectCollab";

const ProjectCollabContext = createContext<ProjectCollabTransport | null>(null);

interface ProjectCollabProviderProps {
  projectId: string;
  children: ReactNode;
}

export function ProjectCollabProvider({
  projectId,
  children,
}: ProjectCollabProviderProps) {
  const projectCollab = useProjectCollab(projectId);

  return (
    <ProjectCollabContext.Provider value={projectCollab}>
      {children}
    </ProjectCollabContext.Provider>
  );
}

export function useProjectCollabContext(): ProjectCollabTransport {
  const context = useContext(ProjectCollabContext);
  if (context == null) {
    throw new Error(
      "useProjectCollabContext must be used within a ProjectCollabProvider",
    );
  }
  return context;
}
