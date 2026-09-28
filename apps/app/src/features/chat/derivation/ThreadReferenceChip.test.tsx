// @vitest-environment jsdom
/** The `from` chip: read from the child's first message, opens the source, says when it's trashed. */
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((out, part, index) => out + part + (values[index] ?? ""), ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
const lookup = vi.hoisted(() => ({
  projectThreads: null as Array<{ id: string; title: string }> | null,
  probe: vi.fn(),
}));
vi.mock("@/client/query/useProjectThreads", () => ({
  useProjectThreads: () => ({ threads: lookup.projectThreads }),
}));
vi.mock("@/client/api/threads-api", () => ({ readThreadTranscript: lookup.probe }));
vi.mock("@/features/project/context/open-project-document", () => ({
  useProjectDocumentNavigationProjectId: () => "project",
}));

import type { Block } from "@meridian/contracts/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatThreadNavigationProvider } from "../ChatThreadNavigation";
import { ThreadReferenceChip } from "./ThreadReferenceChip";
import { readThreadReferences } from "./thread-reference";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  lookup.projectThreads = [];
  lookup.probe.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const referenceBlock = (threadId: string, title: string | null, sequence = 1) =>
  ({
    id: `ref-${threadId}`,
    blockType: "custom",
    sequence,
    content: {
      kind: "thread-reference",
      props: { threadId, ref: "c4", title, agentName: "General", lastActivityAt: "", text: "" },
    },
  }) as unknown as Block;

async function render(reference: { threadId: string; title: string | null }) {
  const onOpen = vi.fn();
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatThreadNavigationProvider onOpenThread={onOpen}>
          <ThreadReferenceChip reference={reference} />
        </ChatThreadNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  return onOpen;
}

describe("readThreadReferences", () => {
  it("reads only thread-reference blocks, in block order", () => {
    const text = { id: "t", blockType: "text", sequence: 0, content: "hi" } as unknown as Block;
    expect(
      readThreadReferences([referenceBlock("b", "Second", 2), text, referenceBlock("a", null, 1)]),
    ).toEqual([
      { threadId: "a", title: null },
      { threadId: "b", title: "Second" },
    ]);
  });
});

describe("ThreadReferenceChip", () => {
  it("names a live source by its current title and opens it", async () => {
    lookup.projectThreads = [{ id: "source", title: "Chapter 12 plan (renamed)" }];
    const onOpen = await render({ threadId: "source", title: "Chapter 12 plan" });
    const link = host.querySelector("button");
    expect(link?.textContent).toBe("Chapter 12 plan (renamed)");
    expect(link?.getAttribute("aria-label")).toBe("Open source chat Chapter 12 plan (renamed)");
    await act(async () => link?.click());
    expect(onOpen).toHaveBeenCalledWith("source");
    expect(lookup.probe).not.toHaveBeenCalled();
  });

  it("says a trashed source is in the trash, and does not offer to open it", async () => {
    lookup.probe.mockRejectedValue(Object.assign(new Error("Thread not found"), { status: 404 }));
    await render({ threadId: "gone", title: "Old outline" });
    await vi.waitFor(() => expect(host.textContent).toContain("Old outline (in the trash)"));
    expect(host.querySelector("button")).toBeNull();
  });

  it("never shows the source's ref: an untitled source reads as an untitled chat", async () => {
    lookup.probe.mockRejectedValueOnce(
      Object.assign(new Error("Thread not found"), { status: 404 }),
    );
    await render({ threadId: "gone", title: null });
    await vi.waitFor(() => expect(host.textContent).toContain("Untitled chat (in the trash)"));
    expect(host.textContent).not.toContain("c4");
  });
});
