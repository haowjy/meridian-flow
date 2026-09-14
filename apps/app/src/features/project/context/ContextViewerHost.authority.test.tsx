// @vitest-environment jsdom
/** A followed binary reference retains its authority through route, tab, and viewer read. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { expect, it, vi } from "vitest";
import { getProjectContextRead } from "@/client/api/projects-api";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { resolveEditorWorkScope } from "../editor-work-scope";
import { openContextRouteSearch } from "../routing/project-route";
import { ContextViewerBareHost, ContextViewerHost } from "./ContextViewerHost";
import { contextTabFromFile } from "./context-tab-from-file";
import { contextTabMatchesRoute } from "./context-tab-identity";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/client/api/projects-api", async (original) => ({
  ...(await original<typeof import("@/client/api/projects-api")>()),
  getProjectContextRead: vi.fn(),
}));

it("reads an explicit no-Work image without inheriting the selected chat Work", async () => {
  const search = openContextRouteSearch(
    { thread: "thread-a" },
    { scheme: "uploads", path: "/Map.png", workId: null },
  );
  expect(search.work).toBe("none");
  const scope = resolveEditorWorkScope({ status: "none" });
  expect(scope).toEqual({ status: "ready", workId: null, source: "route" });
  if (scope.status !== "ready") throw new Error("expected resolved scope");
  expect(contextCatalogScope("project", "uploads", scope.workId)).toEqual({
    kind: "none",
    projectId: "project",
  });
  const tab = contextTabFromFile(
    "uploads",
    {
      kind: "file",
      entryId: "image",
      documentId: "image",
      parentId: "source",
      name: "Map.png",
      path: "/Map.png",
      uri: "uploads://@/Map.png",
      provisionalName: false,
      editable: false,
      disposition: "binary",
      fileType: "image",
      mimeType: "image/png",
    },
    scope.workId,
  );
  expect(contextTabMatchesRoute(tab, "uploads", "/Map.png", scope.workId)).toBe(true);
  if (tab.kind !== "viewer") throw new Error("expected binary viewer");
  vi.mocked(getProjectContextRead).mockResolvedValue({
    kind: "binary",
    path: "/Map.png",
    fileType: "image",
    url: "/signed-map.png",
    mimeType: "image/png",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ContextViewerHost projectId="project" editorWorkId="work-a" tab={tab} />
    </QueryClientProvider>,
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(getProjectContextRead).toHaveBeenCalledWith(
        "project",
        "uploads",
        "/Map.png",
        undefined,
      );
      expect(document.querySelector('img[alt="Map.png"]')?.getAttribute("src")).toBe(
        "/signed-map.png",
      );
    },
  );
  queryClient.clear();
});

it("keeps filename chrome while delaying feedback and resets it for the next file", async () => {
  vi.useFakeTimers();
  let finish!: (value: Awaited<ReturnType<typeof getProjectContextRead>>) => void;
  vi.mocked(getProjectContextRead).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let change!: (state: { path: string; bare?: boolean }) => void;
  function Harness() {
    const [state, setState] = useState({ path: "/Map.png", bare: false });
    change = (next) => setState({ path: next.path, bare: next.bare ?? false });
    const Host = state.bare ? ContextViewerBareHost : ContextViewerHost;
    return (
      <QueryClientProvider client={client}>
        <Host
          projectId="project"
          editorWorkId={null}
          tab={{
            kind: "viewer",
            documentId: state.path,
            scheme: "kb",
            path: state.path,
            name: state.path.slice(1),
            editable: false,
            fileType: "image",
          }}
        />
      </QueryClientProvider>
    );
  }
  try {
    await withReactRoot(<Harness />, async () => {
      const skeleton = () => document.querySelector('[data-slot="skeleton"]');
      const header = document.querySelector("header");
      expect(header?.textContent).toContain("Map.png");
      expect(document.body.textContent).not.toContain("Loading file");
      expect(document.querySelector(".animate-spin")).toBeNull();
      await act(async () => vi.advanceTimersByTime(499));
      expect(skeleton()).toBeNull();
      await act(async () => change({ path: "/Second.png" }));
      expect(document.querySelector("header")).toBe(header);
      expect(header?.textContent).toContain("Second.png");
      await act(async () => vi.advanceTimersByTime(499));
      expect(skeleton()).toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
      expect(skeleton()).not.toBeNull();
      await act(async () => {
        finish({
          kind: "binary",
          path: "/Second.png",
          fileType: "image",
          url: "/signed-second.png",
          mimeType: "image/png",
        });
      });
      await act(async () => vi.advanceTimersByTime(1));
      expect(skeleton()).toBeNull();
      expect(document.querySelector("header")).toBe(header);
      expect(document.querySelector("img")?.getAttribute("src")).toBe("/signed-second.png");
      await act(async () => change({ path: "/Bare.png", bare: true }));
      expect(document.querySelector("header")).toBeNull();
      expect(skeleton()).toBeNull();
    });
  } finally {
    client.clear();
    vi.useRealTimers();
  }
});
