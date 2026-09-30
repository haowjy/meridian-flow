// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextViewer } from "./TextViewer";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("TextViewer query-backed source", () => {
  it("fetches a signed preview once and reuses the query cache when reopened", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "Cached preview",
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <QueryClientProvider client={client}>
          <button type="button" onClick={() => setVisible((current) => !current)}>
            Toggle preview
          </button>
          {visible ? <TextViewer source={{ url: "/signed-note" }} name="Note.txt" /> : null}
        </QueryClientProvider>
      );
    }

    await act(async () => root?.render(<Harness />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(host.textContent).toContain("Cached preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => host.querySelector("button")?.click());
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toContain("Cached preview");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
