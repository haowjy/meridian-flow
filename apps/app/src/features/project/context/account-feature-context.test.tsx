// @vitest-environment jsdom
/**
 * Account feature context behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - projection recovery and StrictMode coordinator reuse
 */

import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
import { reserveResourceDocument } from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  AccountFeatureTestProvider,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { acceptContextTransition } from "@/test-support/context-removal-route";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useObservedResourceProjection } from "./account-feature-context";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { projectResourceTab } from "./context-tab-from-file";

const providerQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function TestAccountProvider(props: React.ComponentProps<typeof AccountFeatureTestProvider>) {
  return (
    <QueryClientProvider client={providerQueryClient}>
      <AccountFeatureTestProvider {...props} />
    </QueryClientProvider>
  );
}

function tracked(documentId: string, path: string) {
  return {
    kind: "tracked" as const,
    documentId,
    scheme: "manuscript" as const,
    path,
    name: path.slice(1),
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
}

describe("AccountFeatureTestProvider", () => {
  it("publishes terminal identity after catalog removal so dock and Editor see absence", async () => {
    let publish: ((snapshot: ResourceProjectionSnapshot) => void) | null = null;
    const replica = {
      observeProjection(
        _projectId: string,
        listener: (snapshot: ResourceProjectionSnapshot) => void,
      ) {
        publish = listener;
        return () => undefined;
      },
    };
    const record = reserveResourceDocument({
      projectId: "project-1",
      handle: "gone",
      documentId: "gone",
      databaseName: "unused",
      schema: "schema",
      intentId: "create",
    }).next;
    record.intents = [];
    record.resource.lifecycle = { kind: "terminal", generation: "9", transitionId: "delete" };
    const projections: ReturnType<typeof projectResourceTab>[] = [];
    function Child() {
      const { records, placement } = useObservedResourceProjection(replica, "project-1");
      projections.push(
        projectResourceTab("project-1", tracked("gone", "/gone.md"), records, placement),
      );
      return null;
    }
    await withReactRoot(<Child />, async () => {
      await act(async () =>
        publish?.({ records: [record], operations: [], catalogs: [], folders: [] }),
      );
      expect(projections.at(-1)).toMatchObject({
        kind: "terminal",
        documentIds: ["gone"],
        generation: "9",
      });
    });
  });

  it("clears a transient projection error when the projection recovers", async () => {
    let publish: ((snapshot: ResourceProjectionSnapshot) => void) | null = null;
    let fail: ((error: unknown) => void) | null = null;
    const replica = {
      observeProjection(
        _projectId: string,
        onSnapshot: (snapshot: ResourceProjectionSnapshot) => void,
        onError: (error: unknown) => void,
      ) {
        publish = onSnapshot;
        fail = onError;
        return () => undefined;
      },
    };
    const observed: Array<ReturnType<typeof useObservedResourceProjection>> = [];
    function Child() {
      observed.push(useObservedResourceProjection(replica, "project-1"));
      return null;
    }

    await withReactRoot(<Child />, async () => {
      await act(async () => fail?.(new Error("temporary projection failure")));
      expect(observed.at(-1)?.error).toBeInstanceOf(Error);

      await act(async () => publish?.({ records: [], folders: [], operations: [], catalogs: [] }));
      expect(observed.at(-1)).toMatchObject({ error: null, records: [] });
    });
  });

  it("reuses one coordinator through Strict effect replay", async () => {
    const selectionRevisions: number[] = [];
    function Child() {
      const coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        coordinator.beginRouteSelection("project-1", {
          scheme: "kb",
          path: "/strict.md",
          workId: "work-1",
        });
        const selection = coordinator.getProjectSnapshot("project-1").selection;
        if (selection.status === "candidate") selectionRevisions.push(selection.revision);
      }, [coordinator]);
      return null;
    }
    await withReactRoot(
      <StrictMode>
        <TestAccountProvider accountId="account-a">
          <Child />
        </TestAccountProvider>
      </StrictMode>,
      async () => {
        expect(selectionRevisions).toEqual([1, 2]);
      },
    );
  });

  it("constructs authority before descendants and isolates A to B to A", async () => {
    useContextTabsStore.setState({
      byProject: {
        "project-1": {
          tabs: [{ ...tracked("a", "/a.md"), tabInstanceId: "instance-a" }],
          selectedTabIdByWork: { "work-1": "a" },
        },
      },
      _workspaceHydrated: true,
    });
    const instances: ContextRemovalCoordinator[] = [];
    const entrySnapshots: ReturnType<ContextRemovalCoordinator["getProjectSnapshot"]>[] = [];
    let setAccount: ((accountId: string) => void) | null = null;
    function Child() {
      const coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        instances.push(coordinator);
        entrySnapshots.push(coordinator.getProjectSnapshot("project-1"));
        coordinator.registerRoutePort(
          "project-1",
          {
            transition: acceptContextTransition,
            readSearch: () => ({ screen: "context" }),
            updateSearch: () => undefined,
          },
          "work-1",
        );
        const revision = coordinator.beginRouteSelection("project-1", {
          scheme: "manuscript",
          path: "/a.md",
          workId: "work-1",
        });
        coordinator.bindRouteSelection("project-1", revision, {
          kind: "server",
          documentId: "a",
        });
        coordinator.activate({
          projectId: "project-1",
          selectionRevision: revision,
          transitionRevision: coordinator.getProjectSnapshot("project-1").transitionRevision,
          locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
          identity: { kind: "server", documentId: "a" },
          owner: {
            kind: "workspace",
            tab: { ...tracked("a", "/a.md"), tabInstanceId: "instance-a" },
          },
        });
      }, [coordinator]);
      return null;
    }
    function Harness() {
      const [accountId, updateAccount] = useState("account-a");
      setAccount = updateAccount;
      return (
        <TestAccountProvider accountId={accountId}>
          <Child />
        </TestAccountProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(instances[0]?.getProjectSnapshot("project-1").admitted?.path).toBe("/a.md");
      await act(async () => setAccount?.("account-b"));
      await act(async () => setAccount?.("account-a"));
      expect(instances).toHaveLength(3);
      expect(instances[0]).not.toBe(instances[2]);
      expect(instances[1]?.accountId).toBe("account-b");
      expect(instances[2]?.accountId).toBe("account-a");
      expect(entrySnapshots.slice(1)).toEqual([
        expect.objectContaining({
          selection: { status: "none", revision: 0 },
          admitted: null,
          removalFence: null,
        }),
        expect.objectContaining({
          selection: { status: "none", revision: 0 },
          admitted: null,
          removalFence: null,
        }),
      ]);
    });
  });
});
