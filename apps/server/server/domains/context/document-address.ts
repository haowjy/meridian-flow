/** Resolve browser bookmarks through current namespace occupancy and stable document identity. */
import type { DocumentId } from "@meridian/contracts";
import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import type { DocumentAddressResolver, DocumentAddressStore } from "./ports/document-address.js";
import type { ProjectContextAvailabilityPort } from "./ports/project-context-availability.js";

export function createDocumentAddressResolver(deps: {
  locations: DocumentAddressStore;
  availability: ProjectContextAvailabilityPort;
}): DocumentAddressResolver {
  async function held(
    kind: "current" | "alias",
    input: Parameters<DocumentAddressResolver["resolveById"]>[0],
  ): Promise<DocumentAddressResult> {
    const { documents } = await deps.availability.placed(
      { projectId: input.projectId, documentIds: [input.documentId], view: input.view },
      { userId: input.userId },
    );
    const found = documents.get(input.documentId);
    return found
      ? {
          kind,
          document: { kind: "available", documentId: input.documentId, generation: "0", ...found },
        }
      : { kind: "unavailable" };
  }
  return {
    resolveById: (input) => held("current", input),
    async resolve(input) {
      const candidate = await deps.locations.candidate(input);
      if (!candidate) return { kind: "unavailable" };
      return held(candidate.kind, { ...input, documentId: candidate.documentId as DocumentId });
    },
  };
}
