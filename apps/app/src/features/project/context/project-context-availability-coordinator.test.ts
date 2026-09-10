/** Project availability drain, ordering, and negative-space tests. */
import type {
  ProjectContextIdentityLookupResult,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectContextAvailabilityCoordinator,
  type ProjectDocumentAvailabilityCommand,
} from "./project-context-availability-coordinator";

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function result(
  projectId: string,
  resolutions: ProjectContextIdentityResolution[],
): ProjectContextIdentityLookupResult {
  return { projectId, resolutionId: crypto.randomUUID(), resolutions };
}

describe("ProjectContextAvailabilityCoordinator", () => {
  it("accepts one normalized generation-fenced committed-delete batch", async () => {
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    let deletedAccepted = false;
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) =>
        result(
          projectId,
          documentIds.map((documentId) =>
            deletedAccepted && documentId === id(2)
              ? { kind: "not-visible", documentId, checkedGeneration: "30" }
              : {
                  kind: "available",
                  documentId,
                  generation: documentId === id(1) ? "29" : "27",
                  authority: { kind: "project", projectId },
                  entry: { entryId: documentId } as never,
                },
          ),
        ),
      repairProjectCatalog: async () => undefined,
      apply: async (commands) => {
        batches.push([...commands]);
      },
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId: id(1) }, { documentId: id(2) }]);
    await coordinator.recheck("project-1", [id(1), id(2)]);
    batches.length = 0;

    deletedAccepted = true;
    await coordinator.acceptCommittedDelete({
      projectId: "project-1",
      deletedDocumentIds: [id(2), id(1), id(2)],
      generation: "28",
    });
    await coordinator.acceptCommittedDelete({
      projectId: "project-1",
      deletedDocumentIds: [id(2)],
      generation: "28",
    });

    expect(batches).toEqual([
      [
        {
          kind: "terminal-remove",
          projectId: "project-1",
          documentId: id(2),
          generation: "28",
          cause: "document-deleted",
          commandId: `availability/v1/terminal-remove/project-1/${id(2)}/28`,
        },
      ],
    ]);

    await coordinator.recheck("project-1", [id(2)]);
    expect(batches[1]).toEqual([]);
  });

  it("retries an equal committed delete after the effect owner throws", async () => {
    const apply = vi.fn(async (_commands: readonly ProjectDocumentAvailabilityCommand[]) => {
      if (apply.mock.calls.length === 1) throw new Error("owner failed");
    });
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId) => result(projectId, []),
      repairProjectCatalog: async () => undefined,
      apply,
    });
    const receipt = {
      projectId: "project-1",
      deletedDocumentIds: [id(1)],
      generation: "28" as const,
    };

    await expect(coordinator.acceptCommittedDelete(receipt)).rejects.toThrow("owner failed");
    await coordinator.acceptCommittedDelete(receipt);
    await coordinator.acceptCommittedDelete(receipt);

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1]?.[0]).toEqual([
      {
        kind: "terminal-remove",
        projectId: "project-1",
        documentId: id(1),
        generation: "28",
        cause: "document-deleted",
        commandId: `availability/v1/terminal-remove/project-1/${id(1)}/28`,
      },
    ]);
  });

  it("drains 257 sorted IDs through three requests, at most two concurrent, and one effect batch", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const calls: string[][] = [];
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) => {
      calls.push([...documentIds]);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      concurrent -= 1;
      return result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "not-visible",
          documentId,
          checkedGeneration: "1",
        })),
      );
    });
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
    });
    const ids = Array.from({ length: 257 }, (_, index) => id(257 - index));
    const lease = coordinator.attachProject("project-1");
    lease.watch(
      "tabs",
      ids.map((documentId) => ({ documentId })),
    );
    await coordinator.recheck("project-1", ids);
    expect(calls.map((call) => call.length)).toEqual([128, 128, 1]);
    expect(calls.flat()).toEqual([...ids].sort());
    expect(maxConcurrent).toBe(2);
    expect(batches).toHaveLength(1);
  });

  it("retries only a failed chunk and never dispatches malformed or unresolved data", async () => {
    const calls: string[][] = [];
    let failed = false;
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) => {
        calls.push([...documentIds]);
        if (!failed) {
          failed = true;
          throw new Error("503");
        }
        return result(
          projectId,
          documentIds.map((documentId) => ({
            kind: "deleted",
            documentId,
            generation: "8",
            lastAuthority: { kind: "project", projectId },
          })),
        );
      },
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
      retryDelayMs: 0,
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId: id(1) }]);
    await coordinator.recheck("project-1", [id(1)]);
    expect(calls).toEqual([[id(1)], [id(1)]]);
    expect(batches[0]?.[0]?.commandId).toBe(`availability/v1/terminal-remove/project-1/${id(1)}/8`);
  });

  it("fences crossed authority generations and suppresses commands for indeterminate results", async () => {
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const pending: Array<(value: ProjectContextIdentityLookupResult) => void> = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: (_projectId, _documentIds) => new Promise((resolve) => pending.push(resolve)),
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
      },
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId: id(1) }]);
    const old = coordinator.recheck("project-1", [id(1)]);
    const newer = coordinator.recheck("project-1", [id(1)]);
    pending[1]?.(
      result("project-1", [
        {
          kind: "deleted",
          documentId: id(1),
          generation: "9",
          lastAuthority: { kind: "project", projectId: "project-1" },
        },
      ]),
    );
    await newer;
    pending[0]?.(
      result("project-1", [
        {
          kind: "available",
          documentId: id(1),
          generation: "8",
          authority: { kind: "project", projectId: "project-1" },
          entry: {} as never,
        },
      ]),
    );
    await old;
    expect(batches.flat().map((command) => command.generation)).toEqual(["9"]);

    const indeterminate = coordinator.recheck("project-1", [id(1)]);
    pending[2]?.(
      result("project-1", [
        {
          kind: "indeterminate",
          documentId: id(1),
          checkedGeneration: "10",
          reason: "identity_inconsistent",
        },
      ]),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[3]?.(
      result("project-1", [
        {
          kind: "indeterminate",
          documentId: id(1),
          checkedGeneration: "10",
          reason: "identity_inconsistent",
        },
      ]),
    );
    await indeterminate;
    expect(batches.flat()).toHaveLength(1);
  });

  it("does no work for an unwatched cold hint and exact-ID lookup for a watched cold hint", async () => {
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) =>
      result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "not-visible",
          documentId,
          checkedGeneration: "1",
        })),
      ),
    );
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    await coordinator.coldScopeHint("project-1", "work-cold");
    expect(lookup).not.toHaveBeenCalled();
    lease.watch("tabs", [{ documentId: id(1), sourceWorkId: "work-cold" }]);
    await coordinator.coldScopeHint("project-1", "work-cold");
    expect(lookup).toHaveBeenCalledWith("project-1", [id(1)]);
  });
});

describe("complete availability drain fences", () => {
  it("repairs all indeterminates with one catalog snapshot and minimum retry chunks", async () => {
    const calls: string[][] = [];
    let repaired = false;
    const repairProjectCatalog = vi.fn(async () => {
      repaired = true;
    });
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) => {
        calls.push([...documentIds]);
        return result(
          projectId,
          documentIds.map((documentId) =>
            repaired
              ? { kind: "not-visible" as const, documentId, checkedGeneration: "2" }
              : {
                  kind: "indeterminate" as const,
                  documentId,
                  checkedGeneration: "1",
                  reason: "identity_inconsistent" as const,
                },
          ),
        );
      },
      repairProjectCatalog,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    const documentIds = Array.from({ length: 129 }, (_, index) => id(index));
    lease.watch(
      "tabs",
      documentIds.map((documentId) => ({ documentId })),
    );
    await coordinator.recheck("project-1");
    expect(repairProjectCatalog).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.length)).toEqual([128, 1, 128, 1]);
  });

  it("quarantines a valid repeated indeterminate but withholds peers on malformed repair", async () => {
    const peer = id(1);
    const uncertain = id(2);
    let malformed = false;
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) => {
        if (documentIds.length === 1 && documentIds[0] === uncertain && malformed) {
          return result(projectId, []);
        }
        return result(
          projectId,
          documentIds.map((documentId) =>
            documentId === peer
              ? {
                  kind: "deleted" as const,
                  documentId,
                  generation: "4",
                  lastAuthority: { kind: "project" as const, projectId },
                }
              : {
                  kind: "indeterminate" as const,
                  documentId,
                  checkedGeneration: "4",
                  reason: "identity_inconsistent" as const,
                },
          ),
        );
      },
      repairProjectCatalog: async () => undefined,
      apply: (commands) => batches.push([...commands]),
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch(
      "tabs",
      [peer, uncertain].map((documentId) => ({ documentId })),
    );
    await coordinator.recheck("project-1");
    expect(
      batches
        .flat()
        .map((command) =>
          command.kind === "available" ? command.document.entryId : command.documentId,
        ),
    ).toEqual([peer]);
    batches.length = 0;
    malformed = true;
    await coordinator.recheck("project-1");
    expect(batches).toEqual([]);
  });

  it("does not admit authority when the effect owner throws", async () => {
    const documentId = id(1);
    let phase: "available" | "not-visible" = "available";
    const batches: ProjectDocumentAvailabilityCommand[][] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId) =>
        result(projectId, [
          phase === "available"
            ? {
                kind: "available" as const,
                documentId,
                generation: "5",
                authority: { kind: "project" as const, projectId },
                entry: { entryId: documentId } as never,
              }
            : { kind: "not-visible" as const, documentId, checkedGeneration: "6" },
        ]),
      repairProjectCatalog: async () => undefined,
      apply: (commands) => {
        batches.push([...commands]);
        if (phase === "available") throw new Error("owner failed");
      },
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId }]);
    await expect(coordinator.recheck("project-1")).rejects.toThrow("owner failed");
    phase = "not-visible";
    await coordinator.recheck("project-1");
    expect(batches.at(-1)).toEqual([]);
  });
});

describe("watch contribution ownership", () => {
  it("retains a Work qualification when an unqualified producer reports later", async () => {
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) =>
      result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "not-visible" as const,
          documentId,
          checkedGeneration: "1",
        })),
      ),
    );
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("qualified", [{ documentId: id(1), sourceWorkId: "work-a" }]);
    lease.watch("retained", [{ documentId: id(1) }]);
    await coordinator.coldScopeHint("project-1", "work-a");
    expect(lookup).toHaveBeenCalledWith("project-1", [id(1)]);
  });
});

describe("final watch fence", () => {
  it("does not dispatch an old result after a newer lookup fails and the ID is unwatched", async () => {
    const documentId = id(1);
    let resolveOld!: (value: ProjectContextIdentityLookupResult) => void;
    let call = 0;
    const apply = vi.fn();
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (_projectId) => {
        call += 1;
        if (call === 1)
          return new Promise((resolve) => {
            resolveOld = resolve;
          });
        throw new Error("offline");
      },
      repairProjectCatalog: async () => undefined,
      apply,
    });
    const lease = coordinator.attachProject("project-1");
    lease.watch("tabs", [{ documentId }]);
    const old = coordinator.recheck("project-1");
    await coordinator.recheck("project-1");
    lease.watch("tabs", []);
    resolveOld(
      result("project-1", [
        {
          kind: "deleted",
          documentId,
          generation: "7",
          lastAuthority: { kind: "project", projectId: "project-1" },
        },
      ]),
    );
    await old;
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("authorization-loss evidence", () => {
  it("emits only current authority loss and never admits a session", async () => {
    const lookup = vi.fn(async (projectId: string, documentIds: readonly string[]) =>
      result(
        projectId,
        documentIds.map((documentId) => ({
          kind: "authority-unavailable" as const,
          documentId,
          generation: "8",
          authority: { kind: "project" as const, projectId },
          reason: "project_deleted" as const,
        })),
      ),
    );
    const losses: unknown[] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup,
      repairProjectCatalog: async () => undefined,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    lease.observeAuthorizationLoss("trail", [{ documentId: "document-1" }], (loss) =>
      losses.push(loss),
    );
    await vi.waitFor(() => expect(losses).toHaveLength(1));
    expect(losses[0]).toMatchObject({
      documentId: "document-1",
      generation: "8",
      reason: "authority-unavailable",
    });
    expect(lookup).toHaveBeenCalledWith("project-1", ["document-1"]);
  });

  it.each(["deleted", "indeterminate"] as const)("retains evidence on %s", async (kind) => {
    const losses: unknown[] = [];
    const coordinator = new ProjectContextAvailabilityCoordinator({
      lookup: async (projectId, documentIds) =>
        result(
          projectId,
          documentIds.map((documentId) =>
            kind === "deleted"
              ? {
                  kind,
                  documentId,
                  generation: "9",
                  lastAuthority: { kind: "project" as const, projectId },
                }
              : {
                  kind,
                  documentId,
                  checkedGeneration: "9",
                  reason: "identity_inconsistent" as const,
                },
          ),
        ),
      repairProjectCatalog: async () => undefined,
      apply: () => undefined,
    });
    const lease = coordinator.attachProject("project-1");
    lease.observeAuthorizationLoss("trail", [{ documentId: "document-1" }], (loss) =>
      losses.push(loss),
    );
    await coordinator.recheck("project-1");
    expect(losses).toEqual([]);
  });
});
