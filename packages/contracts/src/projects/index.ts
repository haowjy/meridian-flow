import type { ProjectId, UserId } from "../ids.js";
import type { ProjectSettings } from "../jsonb.js";

export interface Project {
  id: ProjectId;
  userId: UserId;
  name: string;
  slug: string;
  systemPrompt: string | null;
  settings: ProjectSettings;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type ProjectDto = Omit<Project, "name" | "systemPrompt"> & {
  title: string;
  description: string | null;
};

export type ProjectAvailabilityCode = "project_deleted";

export interface ProjectAvailabilityDetails {
  authenticatedUserId: UserId;
}
