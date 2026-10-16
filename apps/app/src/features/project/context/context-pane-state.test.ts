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
const state = (
  mask: Parameters<typeof deriveContextPaneState>[0]["mask"],
  over: Partial<Parameters<typeof deriveContextPaneState>[0]> = {},
) =>
  deriveContextPaneState({
    activeTab: null,
    tabs: [],
    mask,
    destination,
    removalFenced: false,
    ...over,
  });

it("a masked destination shows its own pending tab, and a terminal verdict is the boundary's", () => {
  const withRetained = (mask: Parameters<typeof state>[0]) =>
    state(mask, { activeTab: retained, tabs: [retained] });
  expect(withRetained({})).toEqual({ kind: "document", tab: retained });
  expect(withRetained({ issue: "loading" })).toEqual({
    kind: "optimistic-loading",
    tab: destination.optimisticTab,
    settledTab: null,
  });
  expect(state({ issue: "loading" }).kind).toBe("optimistic-loading");
  expect(state({}).kind).toBe("optimistic-loading");
  // A terminal verdict is the boundary's to present; the pane stays a neutral wait.
  expect(state({ issue: "unavailable" }).kind).toBe("optimistic-loading");
  expect(state({ issue: "error" }).kind).toBe("optimistic-loading");
});

it("a settled tab for the destination is the strip's one entry while the body loads", () => {
  const settled = {
    kind: "tracked",
    documentId: "new-doc",
    scheme: "manuscript",
    path: "/new.md",
    name: "New",
  } as ContextTab;
  expect(state({ issue: "loading" }, { tabs: [retained, settled] })).toMatchObject({
    kind: "optimistic-loading",
    settledTab: settled,
  });
});
