import type { Project } from "@meridian/contracts/projects";
import type { ProjectId, UserId } from "@meridian/contracts/runtime";

export interface CreateProjectInput {
  id?: ProjectId;
  userId: UserId;
  title?: string;
  description?: string | null;
}

export interface ListProjectsOptions {
  includeDeleted?: boolean;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Promise<Project>;
  findById(id: ProjectId): Promise<Project | null>;
  findLiveByOwnerSlug(userId: UserId, slug: string): Promise<Project | null>;
  listByUser(userId: UserId, opts?: ListProjectsOptions): Promise<Project[]>;
  search(userId: UserId, query: string): Promise<Project[]>;
  rename(id: ProjectId, title: string): Promise<Project>;
  softDelete(id: ProjectId): Promise<Project>;
  restore(id: ProjectId): Promise<Project>;
  touch(id: ProjectId): Promise<void>;
}
