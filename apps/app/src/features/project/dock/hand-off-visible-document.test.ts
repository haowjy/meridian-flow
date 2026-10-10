/** Compact transfer policy and the dock's independent occupant lifetime. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { type DockDocument, useDockViewStore } from "./dock-view-store";
import { handOffVisibleDocument } from "./hand-off-visible-document";

const panelTab = {
  kind: "tracked",
  documentId: "panel",
  name: "panel.md",
  scheme: "manuscript",
  path: "/panel.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
} satisfies ContextTab;
const chatDocument: DockDocument = { projectId: "project", screen: "chat", tab: panelTab };
beforeEach(() => useDockViewStore.setState(useDockViewStore.getInitialState(), true));
it.each([
  { source: "chat", destination: "chat", tab: panelTab },
  { source: "context", destination: "work", tab: panelTab },
  { source: "work", destination: "context", tab: null },
] as const)("no transfer for $source to $destination without an eligible document", (input) => {
  const claim = vi.fn();
  expect(
    handOffVisibleDocument({ ...input, claim, isCurrent: () => true, transfer: vi.fn() }),
  ).toBeUndefined();
  expect(claim).not.toHaveBeenCalled();
});
describe("syncOccupantScope", () => {
  it("parks a Chat occupant across screen changes", () => {
    useDockViewStore.setState({ occupant: chatDocument });
    for (const screen of ["chat", "work", "context", "chat"] as const) {
      useDockViewStore.getState().syncOccupantScope("project", screen, "work");
      expect(useDockViewStore.getState().occupant).toEqual(chatDocument);
    }
  });
  it.each([
    "work",
    "context",
    "chat",
  ] as const)("drops a Work occupant leaving its Work or screen for %s", (screen) => {
    useDockViewStore.setState({
      occupant: {
        ...chatDocument,
        screen: "work",
        tab: { ...panelTab, scheme: "scratch", workId: "work" },
      },
    });
    useDockViewStore.getState().syncOccupantScope("project", "work", "work");
    expect(useDockViewStore.getState().occupant).not.toBeNull();
    useDockViewStore
      .getState()
      .syncOccupantScope("project", screen, screen === "work" ? "other" : "work");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });
  it.each(["chat", "work"] as const)("drops a %s occupant on project change", (screen) => {
    useDockViewStore.setState({ occupant: { ...chatDocument, screen } });
    useDockViewStore.getState().syncOccupantScope("other", screen, "work");
    expect(useDockViewStore.getState().occupant).toBeNull();
  });
});
