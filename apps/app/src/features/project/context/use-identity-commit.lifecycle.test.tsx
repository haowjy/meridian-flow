/** Operation ownership coverage for asynchronous document identity commits. */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { DesiredIdentity } from "./identity-location";

const { moveMock } = vi.hoisted(() => ({ moveMock: vi.fn() }));

vi.mock("./context-identity-mutation", () => ({
  createContextIdentityMutationService: () => ({ move: moveMock }),
}));
vi.mock("./untitled-reconciler-browser", () => ({ queueUntitledIdentity: vi.fn() }));

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
  it("marks only the newest overlapping commit as the navigation owner", async () => {
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
        finishes[1]?.("Latest.md");
        await second;
        finishes[0]?.("First.md");
        await first;

        expect(onCommitted).toHaveBeenNthCalledWith(
          1,
          "doc-1",
          expect.objectContaining({ name: "Latest.md" }),
          { isLatest: true },
        );
        expect(onCommitted).toHaveBeenNthCalledWith(
          2,
          "doc-1",
          expect.objectContaining({ name: "First.md" }),
          { isLatest: false },
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
