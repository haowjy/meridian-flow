/** Exact project-scoped resolution that mints stable Work authority capabilities. */

import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type {
  ResolvedWorkAuthority,
  WorkAuthorityDto,
  WorkHandle,
} from "@meridian/contracts/works";

export interface ProjectWorkAuthorityResolver {
  byId(projectId: ProjectId, workId: WorkId): Promise<ResolvedWorkAuthority | null>;
  byHandle(projectId: ProjectId, workHandle: WorkHandle): Promise<ResolvedWorkAuthority | null>;
  noWork(projectId: ProjectId): Promise<ResolvedWorkAuthority | null>;
  /** Every non-deleted named Work in the project, in one read; No Work has no handle and is left out. */
  listForProject(projectId: ProjectId): Promise<ResolvedWorkAuthority[]>;
  lockById(projectId: ProjectId, workId: WorkId): Promise<ResolvedWorkAuthority | null>;
}

/** Package-internal capability constructor. Adapters must first establish exact row provenance. */
export function resolvedWorkAuthority(value: WorkAuthorityDto): ResolvedWorkAuthority {
  return value as ResolvedWorkAuthority;
}
