/** Exact project-scoped resolution that mints stable Work authority capabilities. */

import type { ProjectId, WorkId } from "@meridian/contracts/runtime";
import type {
  ResolvedWorkAuthority,
  WorkAuthorityDto,
  WorkHandle,
} from "@meridian/contracts/works";

/**
 * The Works addresses name. A deleted Work counts until its purge removes it: its files read like
 * any source's, and file policy refuses the writes. Only `lockById` refuses a deleted Work.
 */
export interface ProjectWorkAuthorityResolver {
  byId(projectId: ProjectId, workId: WorkId): Promise<ResolvedWorkAuthority | null>;
  byHandle(projectId: ProjectId, workHandle: WorkHandle): Promise<ResolvedWorkAuthority | null>;
  noWork(projectId: ProjectId): Promise<ResolvedWorkAuthority | null>;
  /** Every named Work in the project, in one read; No Work has no handle and is left out. */
  listForProject(projectId: ProjectId): Promise<ResolvedWorkAuthority[]>;
  /** Locks the Work's lifecycle; null for a deleted Work. */
  lockById(projectId: ProjectId, workId: WorkId): Promise<ResolvedWorkAuthority | null>;
}

/** Package-internal capability constructor. Adapters must first establish exact row provenance. */
export function resolvedWorkAuthority(value: WorkAuthorityDto): ResolvedWorkAuthority {
  return value as ResolvedWorkAuthority;
}
