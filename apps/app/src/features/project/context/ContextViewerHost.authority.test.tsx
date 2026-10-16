// @vitest-environment jsdom
/** A followed binary reference retains its authority through route, tab, and viewer read. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { getProjectContextRead } from "@/client/api/projects-api";
import { contextCatalogScope } from "@/client/query/useContextCatalog";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextViewerHost } from "./ContextViewerHost";
import { contextTabFromFile } from "./context-tab-from-file";

vi.mock("@/client/api/projects-api", async (original) => ({
  ...(await original<typeof import("@/client/api/projects-api")>()),
  getProjectContextRead: vi.fn(),
}));

it("reads a chat's image with the chat, not the selected Work", async () => {
  expect(contextCatalogScope("project", "uploads", { chatId: "chat-1" })).toEqual({
    kind: "chat",
    projectId: "project",
    chatId: "chat-1",
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
      uri: "uploads://@[c15]/Map.png",
      provisionalName: false,
      editable: false,
      disposition: "binary",
      fileType: "image",
      mimeType: "image/png",
    },
    { chatThreadId: "chat-1" },
  );
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
        chatThreadId: "chat-1",
      });
      expect(document.querySelector('img[alt="Map.png"]')?.getAttribute("src")).toBe(
        "/signed-map.png",
      );
    },
  );
  queryClient.clear();
});
