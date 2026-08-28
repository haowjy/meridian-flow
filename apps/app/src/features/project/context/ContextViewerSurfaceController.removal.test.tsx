// @vitest-environment jsdom
/** Production desktop route materialization under a pending removal repair. */

import { act } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextViewerSurfaceController } from "../ContextPaneController";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type {
  ContextRemovalCoordinator,
  ContextRemovalRoutePort,
} from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";

const tree = {
  kind: "directory",
  name: "",
  path: "",
  children: [
    {
      kind: "file",
      name: "a.md",
      path: "/a.md",
      documentId: "a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};

const queryState = {
  tree,
  capabilities: null,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: () => queryState,
}));
vi.mock("./ContextViewer", () => ({ ContextViewer: () => null }));
vi.mock("./useUntitledTabBridge", () => ({ useUntitledTabBridge: () => undefined }));

let coordinator: ContextRemovalCoordinator | null = null;

function CaptureCoordinator() {
  coordinator = useContextRemovalCoordinator();
  return null;
}

beforeEach(() => {
  coordinator = null;
  queryState.tree = tree;
  queryState.isError = false;
  queryState.isFetching = false;
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "a",
            scheme: "manuscript",
            path: "/a.md",
            name: "a.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        activeTabId: "a",
      },
    },
    _deskHydrated: true,
  });
});

it.each([
  ["loading", false, true],
  ["error with cached absence", true, false],
] as const)("preserves a route candidate during %s", async (_case, isError, isFetching) => {
  queryState.isError = isError;
  queryState.isFetching = isFetching;
  const route: ContextRemovalRoutePort = {
    readSearch: () => ({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/missing.md",
    }),
    updateSearch: () => undefined,
  };

  await withReactRoot(
    <ContextRemovalAccountProvider accountId={`account-${_case}`}>
      <CaptureCoordinator />
      <ProjectContextRemovalController
        projectId="project"
        activeScreen="context"
        activeContextScheme="manuscript"
        activeContextPath="/missing.md"
        editorWorkId="work-1"
        route={route}
      />
      <ContextViewerSurfaceController
        projectId="project"
        editorWorkId="work-1"
        activeContextScheme="manuscript"
        activeContextPath="/missing.md"
        active
        sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
        dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
        onSelectContextPath={vi.fn()}
        onOpenContextTarget={vi.fn()}
      />
    </ContextRemovalAccountProvider>,
    () => {
      if (!coordinator) throw new Error("coordinator did not mount");
      expect(coordinator.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "candidate", locator: { path: "/missing.md" } },
        admitted: { path: "/a.md" },
      });
    },
  );
});

it.each([
  "delayed",
  "failed",
] as const)("does not reopen cached A while %s route repair leaves the old URL visible", async () => {
  const search = {
    screen: "context" as const,
    work: "work-1",
    scheme: "manuscript" as const,
    path: "/a.md",
  };
  let delayedUpdate: ((latest: typeof search) => typeof search) | null = null;
  const route: ContextRemovalRoutePort = {
    readSearch: () => search,
    updateSearch: (_projectId, update) => {
      delayedUpdate = update as (latest: typeof search) => typeof search;
    },
  };

  await withReactRoot(
    <ContextRemovalAccountProvider accountId="account-1">
      <CaptureCoordinator />
      <ProjectContextRemovalController
        projectId="project"
        activeScreen="context"
        activeContextScheme="manuscript"
        activeContextPath="/a.md"
        editorWorkId="work-1"
        route={route}
      />
      <ContextViewerSurfaceController
        projectId="project"
        editorWorkId="work-1"
        activeContextScheme="manuscript"
        activeContextPath="/a.md"
        active
        sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
        dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
        onSelectContextPath={vi.fn()}
        onOpenContextTarget={vi.fn()}
      />
    </ContextRemovalAccountProvider>,
    async () => {
      const service = coordinator;
      if (!service) throw new Error("coordinator did not mount");
      const capture = service.captureDeleteInitiation("project", {
        kind: "file",
        locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
        documentId: "a",
      });
      await act(async () => {
        service.acceptAcknowledgedDelete({
          ...capture,
          cause: "acknowledged-delete",
          confirmed: { status: "deleted", deletedDocumentIds: ["a"] },
        });
      });

      expect(delayedUpdate).not.toBeNull();
      expect(search.path).toBe("/a.md");
      expect(useContextTabsStore.getState().byProject.project).toMatchObject({
        tabs: [],
        activeTabId: null,
      });
      expect(service.getProjectSnapshot("project")).toMatchObject({
        live: true,
        removalFence: { removedDocumentIds: ["a"] },
        admitted: null,
      });
    },
  );
});
