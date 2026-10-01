// @vitest-environment jsdom
/** The source door: the current title wins, and a trashed source keeps its frozen title. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((out, part, index) => out + part + String(values[index] ?? ""), ""),
}));
const api = vi.hoisted(() => ({ readThreadTranscript: vi.fn() }));
vi.mock("@/client/api/threads-api", () => api);
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: [] }),
}));
vi.mock("@/features/project/context/open-project-document", () => ({
  useProjectDocumentNavigationProjectId: () => "project",
}));

import { SourceChatLink, useSourceThread } from "./SourceChatLink";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  api.readThreadTranscript.mockReset();
  document.body.innerHTML = "";
});

function Door({ frozenTitle }: { frozenTitle: string | null }) {
  const source = useSourceThread("source", frozenTitle);
  return (
    <SourceChatLink
      threadId="source"
      title={source.title}
      trashed={source.trashed}
      fallbackName="the source chat"
    />
  );
}

async function render(node: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
  );
}

describe("SourceChatLink", () => {
  it("names a trashed source by the title frozen when it was derived from", async () => {
    api.readThreadTranscript.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    await render(<Door frozenTitle="Chapter 12 plan" />);
    await vi.waitFor(() => expect(host.textContent).toBe("Chapter 12 plan (in the trash)"));
  });

  it("falls back to the caller's name for a trashed source that had no title", async () => {
    api.readThreadTranscript.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    await render(<Door frozenTitle={null} />);
    await vi.waitFor(() => expect(host.textContent).toBe("the source chat (in the trash)"));
  });

  it("prefers the source's current title over the frozen one", async () => {
    api.readThreadTranscript.mockResolvedValue({
      owners: [{ threadId: "source", title: "Chapter 12 plan, revised" }],
    });
    await render(<Door frozenTitle="Chapter 12 plan" />);
    await vi.waitFor(() => expect(host.textContent).toBe("Chapter 12 plan, revised"));
  });
});
