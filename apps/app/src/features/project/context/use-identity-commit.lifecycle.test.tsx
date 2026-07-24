/** Operation ownership coverage through the stateful untitled lifecycle rig. */

import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { DesiredIdentity } from "./identity-location";
import {
  lifecycleGate,
  UNTITLED_TAB,
  UntitledLifecycleRig,
} from "./test-support/UntitledLifecycleRig";
import { identityCommitMayNavigate, useIdentityCommit } from "./use-identity-commit";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

describe("identity commit operation ownership", () => {
  it.each([
    "stale-source",
    "stale-target",
  ] as const)("re-derives and retries a %s result once", async (reason) => {
    const rig = new UntitledLifecycleRig();
    const tab = rig.seedTab();
    rig.identityMove.enqueueResult(
      { status: "retry", reason },
      {
        status: "moved",
        scheme: "manuscript",
        path: "Act 1/Opening.md",
        name: "Opening.md",
      },
    );
    const committed: unknown[] = [];
    let commit!: (target: DesiredIdentity) => Promise<unknown>;

    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        identityMutations: rig.identityMutations,
        onCommitted: (...receipt) => committed.push(receipt),
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={rig.queryClient}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await expect(commit(target("Opening.md"))).resolves.toEqual({ status: "committed" });
      },
    );

    expect(rig.identityMove.calls).toHaveLength(2);
    expect(committed).toHaveLength(1);
  });

  it("returns an actionable error when a fresh retry is still stale", async () => {
    const rig = new UntitledLifecycleRig();
    const tab = rig.seedTab();
    rig.identityMove.setFallback(async () => ({ status: "retry", reason: "stale-source" }));
    let commit!: (target: DesiredIdentity) => Promise<unknown>;

    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        identityMutations: rig.identityMutations,
        onCommitted: () => {},
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={rig.queryClient}>
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

  it("serializes overlapping commits and gives navigation ownership only to the newest", async () => {
    const rig = new UntitledLifecycleRig();
    const tab = rig.seedTab();
    const firstMove = lifecycleGate<{
      status: "moved";
      scheme: "manuscript";
      path: string;
      name: string;
    }>();
    rig.identityMove.enqueueHandler(() => firstMove.promise);
    const secondMove = lifecycleGate<{
      status: "moved";
      scheme: "manuscript";
      path: string;
      name: string;
    }>();
    rig.identityMove.enqueueHandler(() => secondMove.promise);
    const committed: Array<{ name: string; isLatest: boolean }> = [];
    let commit!: (target: DesiredIdentity) => Promise<unknown>;

    function Harness() {
      commit = useIdentityCommit({
        projectId: "project-1",
        tab,
        defaultWorkId: "work-1",
        identityMutations: rig.identityMutations,
        onCommitted: (_documentId, receipt, ownership) =>
          committed.push({ name: receipt.name, isLatest: ownership.isLatest }),
      });
      return null;
    }

    await withReactRoot(
      <QueryClientProvider client={rig.queryClient}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        const first = commit(target("First.md"));
        const second = commit(target("Latest.md"));
        await Promise.resolve();
        firstMove.resolve({
          status: "moved",
          scheme: "manuscript",
          path: "First.md",
          name: "First.md",
        });
        await first;
        await vi.waitFor(() => expect(rig.identityMove.calls).toHaveLength(2));
        secondMove.resolve({
          status: "moved",
          scheme: "manuscript",
          path: "Latest.md",
          name: "Latest.md",
        });
        await second;
      },
    );

    expect(committed).toEqual([
      { name: "First.md", isLatest: false },
      { name: "Latest.md", isLatest: true },
    ]);
  });

  it("refuses navigation after the writer switches tabs", () => {
    expect(identityCommitMayNavigate({ isLatest: true }, "doc-2", UNTITLED_TAB.documentId)).toBe(
      false,
    );
    expect(identityCommitMayNavigate({ isLatest: true }, "doc-1", UNTITLED_TAB.documentId)).toBe(
      true,
    );
    expect(identityCommitMayNavigate({ isLatest: false }, "doc-1", UNTITLED_TAB.documentId)).toBe(
      false,
    );
  });
});

function target(name: string): DesiredIdentity {
  return { name, destination: { scheme: "manuscript", folderPath: "/Act 1" } };
}
