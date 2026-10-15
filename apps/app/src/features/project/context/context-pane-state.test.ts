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

it("a masked destination shows its own pending tab, and only a terminal verdict says missing or failed", () => {
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
  expect(state({ issue: "unavailable" })).toMatchObject({
    kind: "dead-route",
    destination: { name: "new", scheme: "manuscript" },
  });
  expect(state({ issue: "error" }).kind).toBe("route-error");
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
