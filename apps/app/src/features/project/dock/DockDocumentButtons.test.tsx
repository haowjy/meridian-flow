// @vitest-environment jsdom
/** Inline header failure belongs to one dock attempt, not a reusable document identity. */
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectNavigationProvider } from "../routing/ProjectNavigationContext";
import { DockOpenInEditor } from "./DockDocumentButtons";
import { type DockDocument, useDockViewStore } from "./dock-view-store";

vi.mock("./use-dock-document-tab", () => ({
  useDockDocumentTab: (_projectId: string, document: DockDocument) => ({
    tab: document.tab,
    gone: false,
  }),
}));

it("replacing A with B and then A never resurfaces an earlier header failure", async () => {
  i18n.load("en", {});
  i18n.activate("en");
  useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  const A = {
    projectId: "project",
    screen: "chat",
    tab: {
      kind: "tracked",
      documentId: "A",
      name: "A.md",
      scheme: "manuscript",
      path: "/A.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  } satisfies DockDocument;
  const B: DockDocument = { ...A, tab: { ...A.tab, documentId: "B", name: "B.md", path: "/B.md" } };
  const container = document.createElement("div");
  const root = createRoot(container);
  function Header() {
    const document = useDockViewStore((state) => state.occupant);
    return document && <DockOpenInEditor projectId="project" document={document} />;
  }
  const replace = (document: DockDocument) => {
    const store = useDockViewStore.getState();
    store.commit(store.claim(), document);
  };
  try {
    replace(A);
    await act(async () =>
      root.render(
        <I18nProvider i18n={i18n}>
          <ProjectNavigationProvider
            openContextRoute={vi.fn()}
            runDocumentSwitch={async (_operation, fail) => fail()}
          >
            <TooltipProvider>
              <Header />
            </TooltipProvider>
          </ProjectNavigationProvider>
        </I18nProvider>,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Open in Editor"]')?.click(),
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => replace(B));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => replace(A));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  }
});
