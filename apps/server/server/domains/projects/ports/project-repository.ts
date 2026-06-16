/**
 * Project persistence port: the CRUD contract (create/update/list/get/soft-delete)
 * for projects plus its input/option types. The boundary both the drizzle and
 * in-memory project adapters implement.
 */

import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";

export interface CreateProjectInput {
  /** Client-provided ID for optimistic creation. Server generates one if omitted. */
  id?: ProjectId;
  userId: UserId;
  title?: string;
  description?: string | null;
}

export interface UpdateProjectInput {
  title?: string;
  description?: string | null;
}

export interface ListProjectsOptions {
  /** Include soft-deleted projects. Defaults to false. */
  includeDeleted?: boolean;
}

/**
 * Project CRUD backed by the `schema` `projects` table; rows map to the JSON-natural {@link Project} contract (`created_by → userId`).
 */
export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: ProjectId): Promise<Project | null>;
  listByUser(userId: UserId, opts?: ListProjectsOptions): Promise<Project[]>;
  search(userId: UserId, query: string): Promise<Project[]>;
  update(id: ProjectId, input: UpdateProjectInput): Promise<Project>;
  softDelete(id: ProjectId): Promise<Project>;
  restore(id: ProjectId): Promise<Project>;
  touch(id: ProjectId): Promise<void>;
}
