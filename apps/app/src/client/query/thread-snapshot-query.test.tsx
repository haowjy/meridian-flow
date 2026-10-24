// @vitest-environment jsdom
/** Witness: a cache reader above a `useQuery` that builds the key must not update mid-render.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - observer-free snapshot cache subscription
 */
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { threadQueryKeys } from "./thread-query-keys";
import { useThreadSnapshotCache } from "./thread-snapshot-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.restoreAllMocks());

it("does not warn when a child's useQuery builds the key the parent reads", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const client = new QueryClient();
  const key = threadQueryKeys.snapshot("t1");
  function Child() {
    useQuery({ queryKey: key, queryFn: () => new Promise(() => {}) });
    return null;
  }
  function Parent({ open }: { open: boolean }) {
    useThreadSnapshotCache("t1");
    return open ? <Child /> : null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (open: boolean) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Parent open={open} />
        </QueryClientProvider>,
      );
    });
  // The parent is already subscribed when the child opens the chat and builds the key.
  await render(false);
  await render(true);
  expect(errors).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
