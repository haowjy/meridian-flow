/** Resolve browser bookmarks through current namespace occupancy and stable document identity. */
import type { DocumentAddressResolver, DocumentAddressStore } from "./ports/document-address.js";
import type { ProjectContextAvailabilityPort } from "./ports/project-context-availability.js";

export function createDocumentAddressResolver(deps: {
  locations: DocumentAddressStore;
  availability: ProjectContextAvailabilityPort;
}): DocumentAddressResolver {
  return {
    async resolveById(input) {
      const result = await deps.availability.lookup(
        {
          projectId: input.projectId,
          documentIds: [input.documentId],
          view: input.view,
          admitDrafts: true,
        },
        { userId: input.userId },
      );
      const document = result.resolutions[0];
      return document?.kind === "available"
        ? { kind: "current", document }
        : { kind: "unavailable" };
    },
    async resolve(input) {
      const candidate = await deps.locations.candidate(input);
      if (!candidate) return { kind: "unavailable" };
      const result = await deps.availability.lookup(
        { projectId: input.projectId, documentIds: [candidate.documentId], view: input.view },
        { userId: input.userId },
      );
      const document = result.resolutions[0];
      return document?.kind === "available"
        ? { kind: candidate.kind, document }
        : { kind: "unavailable" };
    },
  };
}
