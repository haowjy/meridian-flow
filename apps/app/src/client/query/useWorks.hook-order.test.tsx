// @vitest-environment jsdom
/**
 * `useWorks` keeps one hook order whatever `enabled` says. Callers flip it as
 * their scope loads (the link index enables it only without a Work), and a hook
 * hidden behind it made React drop the whole Editor on a fresh load.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { useWorks } from "./useWorks";

vi.mock("@/features/project/context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => new AbortController().signal,
}));
vi.mock("./works-projection-acquisition", () => ({
  acquireWorksSnapshot: () => new Promise(() => {}),
  workFromSnapshot: () => null,
}));

function Probe({ enabled }: { enabled: boolean }) {
  useWorks("project-1", { enabled });
  return null;
}

it("survives enabled toggling between renders", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const client = new QueryClient();
  const root = createRoot(document.createElement("div"));
  const render = (enabled: boolean) =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe enabled={enabled} />
        </QueryClientProvider>,
      ),
    );

  expect(() => {
    render(false);
    render(true);
    render(false);
  }).not.toThrow();
  act(() => root.unmount());
});
