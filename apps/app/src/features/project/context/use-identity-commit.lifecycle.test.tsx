/** Operation ownership coverage for asynchronous document identity commits. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { DesiredIdentity } from "./identity-location";

const { moveMock } = vi.hoisted(() => ({ moveMock: vi.fn() }));

vi.mock("./context-identity-mutation", () => ({
  createContextIdentityMutationService: () => {
    let generation = 0;
    let tail = Promise.resolve();
    return {
      move: (...args: unknown[]) => {
        const current = ++generation;
        const run = tail.then(() => moveMock(...args));
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run.then((result) => ({ result, isLatest: current === generation }));
      },
    };
  },
}));
vi.mock("./untitled-reconciler-browser", () => ({ queueUntitledIdentity: vi.fn() }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

const { identityCommitMayNavigate, useIdentityCommit } = await import("./use-identity-commit");

const tab: ContextTab = {
  kind: "tracked",
  documentId: "doc-1",
  scheme: "scratch",
  path: "/Untitled.md",
  name: "Untitled.md",
  workId: "work-1",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: true,
};

describe("identity commit operation ownership", () => {
  beforeEach(() => {
    moveMock.mockReset();
  });

  it.each([
    "stale-source",
    "stale-target",
  ] as const)("re-derives and retries a %s result once", async (reason) => {
    useContextTabsStore.setState({
      byProject: {
        "project-1": { tabs: [tab], activeTabId: tab.documentId },
      },
    });
    moveMock.mockResolvedValueOnce({ status: "retry", reason }).mockResolvedValueOnce({
      status: "moved",
      scheme: "manuscript",
      path: "Act 1/Opening.md",
      name: "Opening.md",
    });
    const onCommitted = vi.fn();
    let commit!: (target: DesiredIdentity) => Promise<unknown>;

    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        onCommitted,
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await expect(commit(target("Opening.md"))).resolves.toEqual({ status: "committed" });
      },
    );

    expect(moveMock).toHaveBeenCalledTimes(2);
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("returns an actionable error when a fresh retry is still stale", async () => {
    useContextTabsStore.setState({
      byProject: { "project-1": { tabs: [tab], activeTabId: tab.documentId } },
    });
    moveMock.mockResolvedValue({ status: "retry", reason: "stale-source" });
    let commit!: (target: DesiredIdentity) => Promise<unknown>;
    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        onCommitted: vi.fn(),
      });
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await expect(commit(target("Opening.md"))).resolves.toMatchObject({
          status: "error",
          message: expect.stringContaining("keeps changing"),
        });
      },
    );
  });

  it("serializes overlapping commits and marks only the newest as navigation owner", async () => {
    const finishes: Array<(name: string) => void> = [];
    moveMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push((name) =>
            resolve({ status: "moved", scheme: "manuscript", path: name, name }),
          );
        }),
    );
    const onCommitted = vi.fn();
    let commit!: (target: DesiredIdentity) => Promise<unknown>;

    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        onCommitted,
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={new QueryClient()}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        const first = commit(target("First.md"));
        const second = commit(target("Latest.md"));
        await Promise.resolve();
        finishes[0]?.("First.md");
        await first;
        await Promise.resolve();
        finishes[1]?.("Latest.md");
        await second;

        expect(onCommitted).toHaveBeenNthCalledWith(
          1,
          "doc-1",
          expect.objectContaining({ name: "First.md" }),
          { isLatest: false },
        );
        expect(onCommitted).toHaveBeenNthCalledWith(
          2,
          "doc-1",
          expect.objectContaining({ name: "Latest.md" }),
          { isLatest: true },
        );
      },
    );
  });

  it("refuses navigation after the writer switches tabs", () => {
    expect(identityCommitMayNavigate({ isLatest: true }, "doc-2", "doc-1")).toBe(false);
    expect(identityCommitMayNavigate({ isLatest: true }, "doc-1", "doc-1")).toBe(true);
    expect(identityCommitMayNavigate({ isLatest: false }, "doc-1", "doc-1")).toBe(false);
  });
});

function target(name: string): DesiredIdentity {
  return { name, destination: { scheme: "manuscript", folderPath: "/Act 1" } };
}
