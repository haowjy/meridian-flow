/** Ports for project-final identity reads and ambient availability ordering. */
import type {
  AvailabilityGeneration,
  ProjectContextIdentityLookupRequest,
  ProjectContextIdentityLookupResult,
} from "@meridian/contracts/protocol";

export interface ProjectContextAvailabilityPort {
  lookup(
    input: ProjectContextIdentityLookupRequest,
    actor: { userId: string },
  ): Promise<ProjectContextIdentityLookupResult>;
}

export interface ProjectContextAvailabilityMutationPort {
  advance(input: {
    projectIds: readonly string[];
    userIds: readonly string[];
  }): Promise<AvailabilityGeneration>;
}
