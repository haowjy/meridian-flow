import { describe, expect, it } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";

import { deriveContextPaneState } from "./context-pane-state";

/** A project whose tree loaded fine and simply does not hold the route. */
const emptyCatalog = { findPath: () => null } as unknown as CatalogContextView;

function derive(overrides: Partial<Parameters<typeof deriveContextPaneState>[0]> = {}) {
  return deriveContextPaneState({
    activeTab: null,
    destination: {
      path: "/arc/chapter-1.md",
      scheme: "manuscript",
      optimisticTab: { id: "optimistic:1", name: "chapter-1.md" },
    },
    catalog: emptyCatalog,
    isFetching: false,
    isError: false,
    removalFenced: false,
    ...overrides,
  });
}

describe("a route that resolves to nothing", () => {
  it("names the document the writer was sent to", () => {
    // A timeline door promises the URI the agent used, not that the document
    // still exists. This pane settles that promise, so it has to know which
    // document went missing.
    expect(derive()).toEqual({
      kind: "dead-route",
      destination: { name: "chapter-1", scheme: "manuscript" },
    });
  });

  it("carries the scheme so the pane can say where it looked", () => {
    expect(
      derive({
        destination: {
          path: "/elara.md",
          scheme: "kb",
          optimisticTab: { id: "optimistic:2", name: "elara.md" },
        },
      }),
    ).toEqual({ kind: "dead-route", destination: { name: "elara", scheme: "kb" } });
  });

  it("stays a route error when the tree could not be read at all", () => {
    // Not knowing is not the same as knowing it is gone.
    expect(derive({ isError: true })).toEqual({ kind: "route-error" });
  });

  it("waits rather than declaring a document missing mid-fetch", () => {
    expect(derive({ isFetching: true }).kind).toBe("optimistic-loading");
  });
});
