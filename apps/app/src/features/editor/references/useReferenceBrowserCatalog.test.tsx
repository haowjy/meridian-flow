// @vitest-environment jsdom
/** Cache events drive an open browser without a new editor frame. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { emptyCatalogView } from "@/client/query/context-catalog-cache";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { createReferenceBrowserController } from "@/core/completion";
import type { AtReferenceCatalog } from "@/core/editor/extensions/at-reference";
import { useReferenceBrowserCatalog } from "./useReferenceBrowserCatalog";

vi.mock("@/client/query/useContextCatalog", () => ({
  contextCatalogQueryOptions: (
    _client: unknown,
    projectId: string,
    scope: Parameters<typeof projectQueryKeys.contextCatalog>[1],
  ) => ({
    queryKey: projectQueryKeys.contextCatalog(projectId, scope),
    queryFn: () =>
      scope.kind === "work" ? Promise.reject(new Error("offline")) : new Promise(() => {}),
  }),
}));

it("publishes settlement, failure and removal from the production cache subscription", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let catalog: AtReferenceCatalog | null = null;
  function Harness() {
    catalog = useReferenceBrowserCatalog("project", null, "References");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  const installed = catalog as AtReferenceCatalog | null;
  if (!installed) throw new Error("catalog not installed");
  const browser = createReferenceBrowserController({
    catalog: installed.port,
    openContext: installed.openContext,
    label: () => installed.label,
    onSelect: vi.fn(),
    onCompleteSegment: vi.fn(),
  });
  browser.start({
    query: "kb://",
    text: "@kb://",
    triggerRange: { from: 0, to: 6 },
    candidates: [],
    anchorRect: () => null,
    loading: false,
    requestExit: () => browser.exit(),
  });
  expect(browser.menu.snapshot().meta?.incomplete).toBe(true);
  const scope = { kind: "project" as const, projectId: "project" };
  const key = projectQueryKeys.contextCatalog("project", scope);
  act(() => client.setQueryData(key, { ...emptyCatalogView(scope), generation: "settled" }));
  expect(browser.menu.snapshot().meta).toMatchObject({
    incomplete: false,
    containerScheme: "kb",
    canBacktrack: true,
  });
  await act(async () => {
    await client.cancelQueries({ queryKey: key });
    await client
      .fetchQuery({
        queryKey: key,
        queryFn: () => Promise.reject(new Error("offline")),
        retry: false,
      })
      .catch(() => {});
  });
  expect(browser.menu.snapshot().meta?.loadFailed).toBe(true);
  act(() => client.removeQueries({ queryKey: key }));
  expect(browser.menu.snapshot().meta).toMatchObject({ incomplete: true, loadFailed: false });
  const coldScope = { kind: "work" as const, projectId: "project", workId: "cold" };
  await expect(installed.port.acquire(coldScope, new AbortController().signal)).rejects.toThrow();
  expect(installed.port.status(coldScope)).toBe("error");
  act(() => client.setQueryData(key, { ...emptyCatalogView(scope), generation: "another" }));
  expect(installed.port.status(coldScope)).toBe("error");
  act(() =>
    client.setQueryData(projectQueryKeys.contextCatalog("project", coldScope), {
      ...emptyCatalogView(coldScope),
      generation: "recovered",
    }),
  );
  expect(installed.port.status(coldScope)).toBe("ready");
  browser.exit();
  await act(async () => root.unmount());
  client.clear();
});
