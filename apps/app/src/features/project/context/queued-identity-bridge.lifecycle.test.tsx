/** Lifecycle coverage for queued identity ownership through tab and route settlement. */

import { QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { UntitledLifecycleRig as Rig } from "./test-support/UntitledLifecycleRig";

const reconcilerState = vi.hoisted(() => ({ rig: null as Rig | null }));

vi.mock("./untitled-reconciler-browser", () => ({
  isUntitledPending: () => true,
  queueUntitledIdentity: (...args: Parameters<Rig["reconciler"]["queueIdentity"]>) =>
    reconcilerState.rig?.reconciler.queueIdentity(...args),
  registerUntitledCandidate: (...args: Parameters<Rig["reconciler"]["registerCandidate"]>) =>
    reconcilerState.rig?.reconciler.registerCandidate(...args) ?? (() => {}),
  syncUntitledReceiptOwners: () => {},
}));

const { UntitledLifecycleRig } = await import("./test-support/UntitledLifecycleRig");
const { useIdentityCommit } = await import("./use-identity-commit");
const { useUntitledTabBridge } = await import("./useUntitledTabBridge");

const NEW_TAB = { kind: "new", documentId: "doc-1", name: "Untitled" } as const;

afterEach(() => {
  reconcilerState.rig = null;
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
});

it("settles a queued identity once under the initiating Editor Work", async () => {
  const rig = new UntitledLifecycleRig();
  reconcilerState.rig = rig;
  rig.home.setFallback(async () => ({ scheme: "scratch", workId: "work-b" }));
  rig.seedTab(NEW_TAB);
  rig.start();
  const routeTargets: unknown[] = [];
  let commit!: ReturnType<typeof useIdentityCommit>;
  let showWorkB!: () => void;

  function Harness() {
    const [workId, setWorkId] = useState("work-a");
    const tabs = useContextTabsStore((state) => state.byProject["project-1"]?.tabs ?? []);
    showWorkB = () => setWorkId("work-b");
    commit = useIdentityCommit({
      projectId: "project-1",
      tab: NEW_TAB,
      defaultWorkId: workId,
      identityMutations: rig.identityMutations,
      onCommitted: () => {},
    });
    useUntitledTabBridge({
      projectId: "project-1",
      tabs,
      onOpenContextTarget: (target) => routeTargets.push(target),
    });
    return null;
  }

  await withReactRoot(
    <QueryClientProvider client={rig.queryClient}>
      <Harness />
    </QueryClientProvider>,
    async () => {
      await act(async () => {
        await commit({
          name: "Opening.md",
          destination: { scheme: "manuscript", folderPath: "/Act 1" },
        });
        showWorkB();
      });
      await act(async () => rig.advance());
    },
  );

  expect(rig.home.calls).toEqual([]);
  expect(rig.create.calls[0]?.[0].home.workId).toBe("work-a");
  expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([
    expect.objectContaining({
      kind: "tracked",
      scheme: "manuscript",
      path: "/Act 1/Opening.md",
      workId: undefined,
      provisionalName: false,
    }),
  ]);
  expect(routeTargets).toEqual([
    { scheme: "manuscript", path: "/Act 1/Opening.md", workId: "work-a" },
  ]);
});
