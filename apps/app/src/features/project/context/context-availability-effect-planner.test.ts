import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import type { OpenDocument } from "@/client/stores";
import { planContextAvailabilityBatch } from "./context-availability-effect-planner";
import type { ContextRouteSelection } from "./context-removal-protocol";
import type { ProjectDocumentAvailabilityCommand } from "./project-context-availability-coordinator";

const tab = {
  kind: "tracked",
  documentId: "doc",
  scheme: "manuscript",
  path: "/old.md",
  name: "old.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} as OpenDocument;
const locator = { scheme: "manuscript" as const, path: "/old.md" };

function plan(by: "navigation" | "review") {
  const selection: ContextRouteSelection = {
    status: "bound",
    revision: 1,
    locator,
    identity: { kind: "server", documentId: "doc" },
    by,
  };
  return planContextAvailabilityBatch({
    commands: [
      {
        kind: "available",
        commandId: "c",
        projectId: "p",
        generation: "g",
        document: {
          entryId: "doc",
          name: "new.md",
          aliases: [],
          provisionalName: false,
          uri: "manuscript://new.md",
          path: ["new.md"],
          scope: { kind: "project", projectId: "p" },
        } as unknown as CatalogFileEntry,
      } as ProjectDocumentAvailabilityCommand,
    ],
    project: {
      activeWorkId: "work",
      selection,
      admitted: locator,
      removalFence: null,
      transitionRevision: 0,
      live: true,
    },
    tabs: [tab],
    mainDocumentId: "doc",
    recentRoutes: [],
    routeSearch: { scheme: "manuscript", path: "/old.md" },
    appliedGenerations: new Map(),
  } as Parameters<typeof planContextAvailabilityBatch>[0]);
}

it("a live move relocates a navigation's route but leaves a review address on its own path", () => {
  const moved = plan("navigation");
  expect(moved.admitted?.path).toBe("/new.md");
  expect(moved.routeSearch?.path).toBe("/new.md");

  const reviewing = plan("review");
  expect(reviewing.admitted?.path).toBe("/new.md");
  expect(reviewing.routeSearch?.path).toBe("/old.md");
  expect(reviewing.selection.status === "bound" && reviewing.selection.locator.path).toBe(
    "/old.md",
  );
});

it("a document deleted live stays presented while its draft still holds it", () => {
  const selection: ContextRouteSelection = {
    status: "bound",
    revision: 1,
    locator,
    identity: { kind: "server", documentId: "doc" },
    by: "review",
  };
  const planned = planContextAvailabilityBatch({
    commands: [
      {
        kind: "terminal-remove",
        commandId: "c",
        projectId: "p",
        documentId: "doc",
        generation: "g",
        deletionVersion: null,
        cause: "document-deleted",
      } as ProjectDocumentAvailabilityCommand,
    ],
    project: {
      activeWorkId: "work",
      selection,
      admitted: locator,
      removalFence: null,
      transitionRevision: 0,
      live: true,
    },
    tabs: [tab],
    mainDocumentId: "doc",
    recentRoutes: [],
    routeSearch: { scheme: "manuscript", path: "/old.md", work: "work" },
    appliedGenerations: new Map(),
    held: new Set(["doc"]),
  } as Parameters<typeof planContextAvailabilityBatch>[0]);
  expect(planned.tabs.map((candidate) => candidate.documentId)).toEqual(["doc"]);
});
