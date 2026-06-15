import type { ProjectId, UserId } from "../ids.js";
import type { ProjectSettings } from "../jsonb.js";

export interface Project {
  id: ProjectId;
  userId: UserId;
  name: string;
  /** Alias for name used by project CRUD routes. */
  title: string;
  slug: string;
  isPersonal: boolean;
  systemPrompt: string | null;
  /** Alias for systemPrompt used by project CRUD routes. */
  description: string | null;
  settings: ProjectSettings;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export type { ProjectStatsResponse } from "./stats.js";
