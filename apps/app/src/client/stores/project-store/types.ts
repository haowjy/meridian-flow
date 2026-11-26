import type { ProjectDto as Project } from "@meridian/contracts/projects";

export type ProjectStoreState = {
  now: number;
};

export type ProjectStoreActions = {
  ensureProject(project: Project): void;
};
