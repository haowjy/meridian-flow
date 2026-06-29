/**
 * @vitest-environment jsdom
 *
 * Integration coverage for ContextPaneController's route-tab gate. The center
 * context surface is mounted persistently but parked offscreen on non-context
 * screens, so route-owned scheme/path must not open tabs until the surface is
 * active.
 */
import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeTreeState = vi.hoisted(() => ({
  tree: null as ProjectContextTreeDirectory | null,
}));

vi.mock("@/client/query/useContextWorkId", () => ({
  useContextWorkId: () => null,
}));

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: (
    _projectId: string,
    _scheme: string,
    options?: { enabled?: boolean; activeThreadId?: string | null },
  ) => ({
    tree: options?.enabled === false ? null : routeTreeState.tree,
    isError: false,
    isFetching: false,
  }),
}));

vi.mock("./context/ContextViewer", () => ({
  ContextViewer: () => <div data-context-viewer />,
}));

import { useContextTabsStore } from "@/client/stores/context-tabs-store";
import { ContextViewerSurfaceController } from "./ContextPaneController";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const DOC_ID = "00000000-0000-4000-8000-0000000000aa";
const DOC_PATH = "/notes/active.md";

const routeTree: ProjectContextTreeDirectory = {
  kind: "dir",
  name: "Knowledge Base",
  path: "/",
  uri: "kb://",
  children: [
    {
      kind: "file",
      documentId: DOC_ID,
      name: "active.md",
      path: DOC_PATH,
      uri: `kb://${DOC_PATH}`,
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};

const openToggle = { open: true, onExpand: () => undefined, label: "Expand" };

function renderController(root: Root, active: boolean): void {
  act(() => {
    root.render(
      <ContextViewerSurfaceController
        projectId={PROJECT_ID}
        activeThreadId={null}
        activeContextScheme="kb"
        activeContextPath={DOC_PATH}
        onSelectContextPath={() => undefined}
        active={active}
        sidebarToggle={openToggle}
        dockToggle={openToggle}
      />,
    );
  });
}

function openTabIds(): string[] {
  return (
    useContextTabsStore.getState().byProject[PROJECT_ID]?.tabs.map((tab) => tab.documentId) ?? []
  );
}

describe("ContextPaneController route-tab gate", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    routeTreeState.tree = routeTree;
    useContextTabsStore.setState({ byProject: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    routeTreeState.tree = null;
    useContextTabsStore.setState({ byProject: {} });
  });

  it("does not open a route tab while inactive, then opens it when activated", () => {
    renderController(root, false);
    expect(openTabIds()).toEqual([]);

    renderController(root, true);
    expect(openTabIds()).toEqual([DOC_ID]);
  });
});
