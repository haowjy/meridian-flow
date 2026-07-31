// @vitest-environment jsdom
/**
 * Regression: a finished upload must invalidate the project's context-tree
 * queries. The sidebar tree and the `@` menu both read that catalog, and an
 * asset that uploaded but never appears until a full reload is the writer's
 * picture going missing from every reference surface.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

// The ingress lane's refusal copy is a macro the test transform does not
// compile; none of these cases are about that copy.
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part),
}));

const { uploadFigureMock, getProjectContextTreeMock } = vi.hoisted(() => ({
  uploadFigureMock: vi.fn(),
  getProjectContextTreeMock: vi.fn(),
}));

vi.mock("@/client/api/figures-api", () => ({ uploadFigure: uploadFigureMock }));
// The thread store wants a provider this runtime never needs; the pending flag
// only gates the thread list fetch, which this test seeds around anyway.
vi.mock("@/client/stores", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsProjectPendingCreation: () => false,
}));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectContextTree: getProjectContextTreeMock,
  listProjectThreads: vi.fn().mockResolvedValue([]),
}));

const { projectQueryKeys } = await import("@/client/query/project-query-keys");
const { imageIngressStorage } = await import("@/core/editor/images/image-ingress-runtime");
const { withReactRoot } = await import("@/test-support/react-dom-harness");
const { createStandaloneEditor } = await import("@/test-support/standalone-editor");
const { ImageIngressRuntime } = await import("./ImageIngressRuntime");

const TREE_RESPONSE = {
  projectId: "project-1",
  scheme: "manuscript",
  tree: { kind: "dir", name: "", path: "/", uri: "manuscript://", children: [] },
};

const UPLOADED = {
  assetDocumentId: "asset-1",
  assetPath: "assets/map.png",
  storageUrl: "storage://asset-1",
  mimeType: "image/png",
  fileType: "image",
  sizeBytes: 3,
  figure: { alt: "map" },
  signedUrl: "https://signed.example/map.png",
  signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("ImageIngressRuntime upload completion", () => {
  it("refetches the project's context tree once the asset exists", async () => {
    uploadFigureMock.mockResolvedValue(UPLOADED);
    getProjectContextTreeMock.mockResolvedValue(TREE_RESPONSE);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Fresh within the tree query's staleTime, so mounting alone fetches
    // nothing: any refetch below is the upload's own doing.
    queryClient.setQueryData(
      projectQueryKeys.contextTree("project-1", "manuscript"),
      TREE_RESPONSE,
    );

    const { editor, destroy } = createStandaloneEditor();
    try {
      await withReactRoot(
        <QueryClientProvider client={queryClient}>
          <ImageIngressRuntime editor={editor} projectId="project-1" documentId="document-1" />
        </QueryClientProvider>,
        async () => {
          const host = imageIngressStorage(editor)?.host;
          if (!host) throw new Error("expected the runtime to register an ingress host");
          expect(getProjectContextTreeMock).not.toHaveBeenCalled();

          await act(async () => {
            await host.upload({
              file: new File(["png"], "map.png", { type: "image/png" }),
              alt: "map",
              signal: new AbortController().signal,
              onProgress: () => {},
            });
          });

          await vi.waitFor(() =>
            expect(getProjectContextTreeMock).toHaveBeenCalledWith(
              "project-1",
              "manuscript",
              undefined,
            ),
          );
        },
        { drainMacrotask: true },
      );
    } finally {
      destroy();
      queryClient.clear();
    }
  });
});
