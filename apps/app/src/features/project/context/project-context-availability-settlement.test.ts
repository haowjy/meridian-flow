/** Production-owner composition proofs for durable-local availability publication. */
import { describe, expect, it, vi } from "vitest";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextAvailabilityCoordinator } from "./project-context-availability-coordinator";

const projectId = "project-settlement";
const documentId = "00000000-0000-4000-8000-000000000077";

function unavailable(generation = "8") {
  return {
    kind: "authority-unavailable" as const,
    documentId,
    generation,
    authority: { kind: "project" as const, projectId },
    reason: "project_deleted" as const,
  };
}

function composed(settleWorkspace: () => Promise<void>) {
  const removal = new ContextRemovalCoordinator("account", {
    workspace: {
      read: () => ({
        tabs: [
          {
            kind: "tracked" as const,
            tabInstanceId: "tab",
            documentId,
            scheme: "scratch" as const,
            path: "/Draft.md",
            name: "Draft.md",
            workId: "work",
            editable: true as const,
            filetype: "markdown" as const,
            schemaType: "document" as const,
          },
        ],
        selectedTabIdByWork: { work: documentId },
      }),
      commit: () => [],
      settleDraft: async () => ({ kind: "not-settled" as const }),
      previewReviewTab: () => ({
        kind: "not-consumed",
        current: { tabs: [], selectedTabIdByWork: {} },
      }),
      closeReviewTab: () => ({
        kind: "not-consumed" as const,
        current: { tabs: [], selectedTabIdByWork: {} },
      }),
      applyAvailability: settleWorkspace,
    },
  });
  const availability = new ProjectContextAvailabilityCoordinator({
    lookup: async () => ({
      projectId,
      resolutionId: crypto.randomUUID(),
      resolutions: [unavailable()],
    }),
    apply: async (commands) => {
      await removal.reconcileDocumentAvailability(commands).localSettlement;
    },
    repairProjectCatalog: async () => undefined,
  });
  return { availability, removal };
}

describe("project availability durable-local settlement", () => {
  it("defers open resolution and authorization publication until the workspace receipt", async () => {
    let resolveWorkspace!: () => void;
    const workspaceSettlement = new Promise<void>((resolve) => {
      resolveWorkspace = resolve;
    });
    const { availability, removal } = composed(() => workspaceSettlement);
    const losses: string[] = [];
    const lease = availability.attachProject(projectId);
    lease.observeAuthorizationLoss("observer", [{ documentId }], (loss) =>
      losses.push(loss.generation),
    );

    await vi.waitFor(() => expect(removal.getProjectSnapshot(projectId).removalFence).toBeNull());
    expect(losses).toEqual([]);

    resolveWorkspace();
    await vi.waitFor(() => expect(losses).toEqual(["8"]));
    expect(removal.getProjectSnapshot(projectId).removalFence).toMatchObject({
      removedDocumentIds: [documentId],
    });
    lease.release();
  });

  it("does not publish or fence a rejected workspace receipt", async () => {
    let reject = true;
    const { availability, removal } = composed(async () => {
      if (reject) throw new Error("durable workspace rejected");
    });

    await expect(availability.resolveForOpen(projectId, documentId)).rejects.toThrow(
      "durable workspace rejected",
    );
    expect(removal.getProjectSnapshot(projectId).removalFence).toBeNull();

    reject = false;
    await expect(availability.resolveForOpen(projectId, documentId)).resolves.toMatchObject({
      kind: "authority-unavailable",
      generation: "8",
    });
    expect(removal.getProjectSnapshot(projectId).removalFence).toMatchObject({
      removedDocumentIds: [documentId],
    });
  });
  it("does not acknowledge a delete while removal is suspended and retries it after resume", async () => {
    const settleWorkspace = vi.fn(async () => undefined);
    const { availability, removal } = composed(settleWorkspace);
    const lifetime = removal.createLifetimeLease();
    const deletion = { projectId, deletedDocumentIds: [documentId], generation: "9" };
    lifetime.suspend();
    await expect(availability.acceptCommittedDelete(deletion)).rejects.toThrow("unavailable");
    expect(settleWorkspace).not.toHaveBeenCalled();
    lifetime.resume();
    await expect(availability.acceptCommittedDelete(deletion)).resolves.toBeUndefined();
    expect(settleWorkspace).toHaveBeenCalledOnce();
    await availability.acceptCommittedDelete(deletion);
    expect(settleWorkspace).toHaveBeenCalledOnce();
    lifetime.suspend();
    lifetime.disposeIfSuspended();
    await expect(
      availability.acceptCommittedDelete({ ...deletion, generation: "10" }),
    ).rejects.toThrow("unavailable");
  });
});
