// @vitest-environment jsdom
/** A followed binary reference retains its authority through route, tab, and viewer read. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { getProjectContextRead } from "@/client/api/projects-api";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { openContextRouteSearch } from "../routing/project-route";
import { ContextViewerHost } from "./ContextViewerHost";
import { contextTabFromFile } from "./context-tab-from-file";
import { contextTabMatchesRoute } from "./context-tab-identity";

vi.mock("@/client/api/projects-api", async (original) => ({
  ...(await original<typeof import("@/client/api/projects-api")>()),
  getProjectContextRead: vi.fn(),
}));

it("reads an explicit no-Work image without inheriting the selected chat Work", async () => {
  const search = openContextRouteSearch(
    {},
    { scheme: "uploads", path: "/Map.png", workId: "no-work" },
  );
  expect(search.work).toBe("no-work");
  const scope = { status: "ready", workId: "no-work" } as const;
  expect(contextCatalogScope("project", "uploads", scope.workId)).not.toBeNull();
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
      expect(getProjectContextRead).toHaveBeenCalledWith("project", "uploads", "/Map.png", {
        workId: "no-work",
      });
      expect(document.querySelector('img[alt="Map.png"]')?.getAttribute("src")).toBe(
        "/signed-map.png",
      );
    },
  );
  queryClient.clear();
});
