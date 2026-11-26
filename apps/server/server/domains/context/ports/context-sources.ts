import type { ContextSourceId, ProjectId, UserId } from "@meridian/contracts";
import type { ContextSource, ContextSourceOwner } from "@meridian/contracts/protocol";

export interface ContextSources {
  inProject(projectId: ProjectId): Promise<ContextSource[]>;
  endedIn(projectId: ProjectId): Promise<ContextSourceId[]>;
  ofUser(userId: UserId): Promise<ContextSource[]>;
  ownedBy(
    projectId: ProjectId,
    owner: Exclude<ContextSourceOwner, { kind: "account" }>,
  ): Promise<ContextSource[]>;
}
