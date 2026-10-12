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
  /** Reserve availability ordering without publishing liveness. Supplying affected
   * authorities publishes a fresh namespace observation watermark in this transaction. */
  reserve(input?: {
    projectIds: readonly string[];
    userIds: readonly string[];
  }): Promise<AvailabilityGeneration>;
  /** Publish a reserved generation in the caller's ambient transaction. */
  publishReserved(input: {
    generation: AvailabilityGeneration;
    projectIds: readonly string[];
    userIds: readonly string[];
  }): Promise<void>;
}
