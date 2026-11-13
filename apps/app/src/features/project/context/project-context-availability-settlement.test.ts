/** Production-owner composition proofs for availability settlement under a removal lifetime.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a suspended removal lifetime refuses committed deletes until it resumes
 */
import { describe, expect, it } from "vitest";
import type { OpenDocument } from "@/client/stores";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

const projectId = "project-settlement";
const documentId = "00000000-0000-4000-8000-000000000077";
const tab: OpenDocument = {
  kind: "tracked",
  documentId,
  scheme: "scratch",
  path: "/Branch.md",
  name: "Branch.md",
  workId: "work",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function composed() {
  const removal = new ContextRemovalCoordinator("account", {
    presented: { documents: () => [tab], mainDocumentId: () => documentId, forget: () => {} },
  });
  const availability = new ProjectContextAvailabilityCoordinator({
    lookup: async () => ({ projectId, resolutionId: crypto.randomUUID(), resolutions: [] }),
    apply: async (commands) => {
      await removal.reconcileDocumentAvailability(commands).localSettlement;
    },
    repairProjectCatalog: async () => undefined,
  });
  return { availability, removal };
}

describe("project availability settlement", () => {
  it("does not acknowledge a delete while removal is suspended and accepts it after resume", async () => {
    const { availability, removal } = composed();
    const lifetime = removal.createLifetimeLease();
    const deletion = {
      projectId,
      deletedDocumentIds: [documentId],
      generation: "9",
      deletionVersion: "4",
    };
    lifetime.suspend();
    await expect(availability.acceptCommittedDelete(deletion)).rejects.toThrow("unavailable");
    lifetime.resume();
    await expect(availability.acceptCommittedDelete(deletion)).resolves.toBeUndefined();
    lifetime.suspend();
    lifetime.disposeIfSuspended();
    await expect(
      availability.acceptCommittedDelete({ ...deletion, generation: "10" }),
    ).rejects.toThrow("unavailable");
  });
});
