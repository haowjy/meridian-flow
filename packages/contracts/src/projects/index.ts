import type { ProjectId, UserId } from "../ids.js";
import type { ProjectSettings } from "../jsonb.js";

export interface Project {
  id: ProjectId;
  userId: UserId;
  name: string;
  slug: string;
  isPersonal: boolean;
  systemPrompt: string | null;
  settings: ProjectSettings;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type { ProjectStatsResponse } from "./stats.js";
