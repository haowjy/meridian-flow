// @vitest-environment jsdom
/** Document restoration must not rewrite the persisted choice or cancel the pending document. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DockShell } from "./DockShell";
import { useDockViewStore } from "./dock-view-store";

vi.mock("../DesktopProjectController", () => ({ usePresentedDockDocument: () => undefined }));
vi.mock("./DockDocumentView", () => ({ DockDocumentView: () => null }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("uses the primary view during restoration without committing a new intent", async () => {
  useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  const restoring = {
    projectId: "project",
    screen: "chat" as const,
    tab: { kind: "new" as const, documentId: "local", resourceHandle: "local", name: "Untitled" },
  };
  useDockViewStore.setState({ byScreen: { chat: "context" }, restoring });
  const revision = useDockViewStore.getState().revision;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <DockShell
          projectId="project"
          placement="dock"
          screen="chat"
          renderHeader={({ view }) => <span>{view}</span>}
        >
          <p>Recent</p>
        </DockShell>,
      ),
    );
    expect(container.textContent).toContain("context");
    expect(useDockViewStore.getState().byScreen.chat).toBe("context");
    expect(useDockViewStore.getState().restoring).toBe(restoring);
    expect(useDockViewStore.getState().revision).toBe(revision);
  } finally {
    await act(async () => root.unmount());
    useDockViewStore.setState(useDockViewStore.getInitialState(), true);
  }
});
