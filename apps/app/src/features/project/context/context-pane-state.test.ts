import type { ProjectContextTreeDirectory } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { deriveContextPaneState, findActiveUntitledTab } from "./context-pane-state";

const route = { path: "/chapter-1.md", optimisticTab: { id: "route", name: "chapter-1.md" } };
const emptyTree: ProjectContextTreeDirectory = {
  kind: "dir",
  name: "Manuscript",
  path: "/",
  uri: "manuscript://",
  children: [],
};
const matchingTree: ProjectContextTreeDirectory = {
  ...emptyTree,
  children: [
    {
      kind: "file",
      name: "chapter-1.md",
      path: route.path,
      uri: "manuscript://chapter-1.md",
      documentId: "document-1",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      provisionalName: false,
    },
  ],
};
const activeTab: ContextTab = {
  kind: "tracked",
  documentId: "document-1",
  scheme: "manuscript",
  path: route.path,
  name: "chapter-1.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function derive(overrides: Partial<Parameters<typeof deriveContextPaneState>[0]> = {}) {
  return deriveContextPaneState({
    activeTab: null,
    destination: route,
    tree: null,
    isFetching: false,
    isError: false,
    autoOpenBlocked: false,
    ...overrides,
  });
}

describe("deriveContextPaneState", () => {
  it("activates a fresh-project untitled tab without a routed scheme", () => {
    const untitled: ContextTab = { kind: "new", documentId: "new-1", name: "Untitled" };
    expect(findActiveUntitledTab([untitled], "new-1")).toBe(untitled);
    expect(
      derive({ activeTab: findActiveUntitledTab([untitled], "new-1"), destination: null }),
    ).toEqual({ kind: "document", tab: untitled });
  });

  it("keeps a cached miss optimistic while the tree revalidates", () => {
    expect(derive({ tree: emptyTree, isFetching: true }).kind).toBe("optimistic-loading");
  });

  it("shows optimistic loading before the initial tree arrives", () => {
    expect(derive({ isFetching: true }).kind).toBe("optimistic-loading");
  });

  it("names a query error without a tree separately", () => {
    expect(derive({ isError: true }).kind).toBe("route-error");
  });

  it("marks a route missing from a validated tree as dead", () => {
    expect(derive({ tree: emptyTree }).kind).toBe("dead-route");
  });

  it("holds a found route while its durable tab materializes", () => {
    expect(derive({ tree: matchingTree }).kind).toBe("optimistic-loading");
  });

  it("keeps a deliberately closed route on the empty desk", () => {
    expect(derive({ tree: matchingTree, autoOpenBlocked: true }).kind).toBe("empty-desk");
  });

  it("renders the active document", () => {
    expect(derive({ activeTab })).toEqual({ kind: "document", tab: activeTab });
  });
});
