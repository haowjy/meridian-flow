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
  listForProject(projectId: ProjectId): Promise<ResolvedWorkAuthority[]>;
  lockById(projectId: ProjectId, workId: WorkId): Promise<ResolvedWorkAuthority | null>;
}

export function resolvedWorkAuthority(value: WorkAuthorityDto): ResolvedWorkAuthority {
  return value as ResolvedWorkAuthority;
}
