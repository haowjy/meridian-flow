// @vitest-environment jsdom
/** Warm-tab host composition must never repair scroll over a mounted editor's jump. */

import { act, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { createStandaloneEditor } from "@/test-support/standalone-editor";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import type { ContextPaneState } from "./context/context-pane-state";
import { resolveVisibleEditorTab } from "./context/resolve-visible-editor-tab";

const fixtures = vi.hoisted(() => ({
  tabs: ["chapter", "other"].map((documentId) => ({
    kind: "tracked",
    documentId,
    tabInstanceId: documentId,
    workId: "work",
    name: `${documentId}.md`,
    scheme: "manuscript",
    path: `/${documentId}.md`,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  })),
  removal: { selection: { status: "none", revision: 0 }, removalFence: null },
  projection: { records: [], folders: [] },
}));
vi.mock("@/client/stores", () => ({
  useContextTabs: () => ({ tabs: fixtures.tabs }),
  useContextTabsStore: () => true,
  useContextTabsActions: () => ({}),
  isEditorTab: () => true,
}));
vi.mock("@/client/query/useContextCatalog", () => ({ useContextCatalogView: () => ({}) }));
vi.mock("./context/account-feature-context", () => ({
  useContextRemovalCoordinator: () => ({}),
  useProjectContextAvailabilityCoordinator: () => ({}),
  useAccountResourceReplica: () => ({}),
  useAccountResourceProjection: () => fixtures.projection,
}));
vi.mock("./context/use-context-removal-project", () => ({
  useContextRemovalProject: () => fixtures.removal,
}));
vi.mock("./context/context-tab-from-file", () => ({
  projectResourceTab: () => ({ kind: "none" }),
}));
vi.mock("./routing/ProjectNavigationContext", () => ({ useCaptureProjectNavigation: () => null }));
// Keep the real controller and real mounted editor; replace unrelated viewer chrome only.
let manuscript: ReturnType<typeof createStandaloneEditor>;
vi.mock("./context/ContextViewer", () => ({
  ContextViewer: ({ paneState }: { paneState: ContextPaneState }) => {
    const host = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const pane = manuscript.editor.view.dom.closest("[data-stable-layout-scroll]");
      if (!pane) throw new Error("Expected manuscript pane");
      host.current?.append(pane);
    }, []);
    return (
      <div
        ref={host}
        data-context-editor-document-id="chapter"
        hidden={paneState.kind !== "document" || paneState.tab.documentId !== "chapter"}
      />
    );
  },
}));

it("keeps a passage visible after jumping 150ms into a warm tab's reveal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  manuscript = createStandaloneEditor({
    content: "<p>Opening passage</p><p>Remembered passage</p>",
  });
  const pane = manuscript.editor.view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
  if (!pane) throw new Error("Expected manuscript pane");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.hasAttribute("data-passage-match") ? 40 - pane.scrollTop : 0;
    return {
      top,
      bottom: top + 20,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: top,
      toJSON() {},
    };
  });
  // jsdom has no scrolling layout. The real passage command requests a DOM jump.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {
      pane.scrollTop = 0;
    },
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const render = async (documentId: string) => {
    const tabs = fixtures.tabs as ContextTab[];
    await act(async () =>
      root.render(
        <ContextViewerSurfaceController
          projectId="project"
          editorWorkId="work"
          editorWork={null}
          active
          resolvedEditor={resolveVisibleEditorTab({
            tabs,
            selectedTabId: documentId,
            selection: { status: "none", revision: 0 },
            editorWorkId: "work",
            activeContextScheme: "manuscript",
            activeContextPath: `/${documentId}.md`,
          })}
          activeContextScheme="manuscript"
          activeContextPath={`/${documentId}.md`}
          onSelectContextPath={() => {}}
          onOpenContextTarget={async () => ({ kind: "applied" as const })}
          onShowEditorRecents={() => {}}
          sidebarToggle={{ open: true, label: "Sidebar", onExpand() {} }}
          dockToggle={{ open: true, label: "Dock", onExpand() {} }}
        />,
      ),
    );
  };
  try {
    await render("chapter");
    pane.scrollTop = 4000;
    pane.dispatchEvent(new Event("scroll"));
    await act(async () => vi.advanceTimersByTime(250));
    await render("other");
    await render("chapter");
    expect(pane.scrollTop).toBe(4000);
    await act(async () => vi.advanceTimersByTime(150));
    await act(async () => {
      expect(manuscript.editor.commands.showPassageMatches([{ from: 5, to: 10 }])).toBe(true);
      vi.advanceTimersByTime(20);
    });
    expect(pane.scrollTop).toBe(0);
    await act(async () => vi.advanceTimersByTime(1300));
    const target = pane.querySelector<HTMLElement>("[data-passage-match]");
    if (!target) throw new Error("Expected highlighted passage");
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(24);
    expect(pane.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    manuscript.destroy();
    host.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
