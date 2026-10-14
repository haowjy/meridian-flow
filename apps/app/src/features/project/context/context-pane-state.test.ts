/** The Editor frame's pane state names where the writer is going, not the document retained under a failure. */
import { expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { deriveContextPaneState } from "./context-pane-state";

const retained = { kind: "tracked", documentId: "old", name: "Old" } as ContextTab;
const destination = {
  path: "/new.md",
  scheme: "manuscript" as const,
  optimisticTab: { id: "optimistic:new", name: "New" },
};

it("a masked destination shows its own pending tab, never the retained document", () => {
  const state = (masked: boolean) =>
    deriveContextPaneState({
      activeTab: retained,
      tabs: [retained],
      masked,
      destination,
      catalog: null,
      isFetching: false,
      isError: false,
      removalFenced: false,
    });
  expect(state(false)).toEqual({ kind: "document", tab: retained });
  expect(state(true)).toEqual({
    kind: "optimistic-loading",
    tab: destination.optimisticTab,
    settledTab: null,
  });
});

it("a settled tab for the destination is the strip's one entry while the body loads", () => {
  const settled = {
    kind: "tracked",
    documentId: "new-doc",
    scheme: "manuscript",
    path: "/new.md",
    name: "New",
  } as ContextTab;
  const state = deriveContextPaneState({
    activeTab: null,
    tabs: [retained, settled],
    masked: false,
    destination,
    catalog: null,
    isFetching: true,
    isError: false,
    removalFenced: false,
  });
  expect(state).toMatchObject({ kind: "optimistic-loading", settledTab: settled });
});
