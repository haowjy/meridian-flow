// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, useCallback, useLayoutEffect, useState } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  AccountFeatureTestProvider,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";

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
  it("renders a new account's children immediately without a preparation projection", () => {
    const html = renderToString(
      <TestAccountProvider accountId="account-a">
        <p>Writer workspace</p>
      </TestAccountProvider>,
    );

    expect(html).toContain("Writer workspace");
    expect(html).not.toContain(["Preparing", "your", "workspace"].join(" "));
  });

  it("keeps the account coordinator across an ordinary composition rerender", async () => {
    const instances: ContextRemovalCoordinator[] = [];
    let rerender: (() => void) | null = null;
    function Child() {
      instances.push(useContextRemovalCoordinator());
      return null;
    }
    function AuthenticatedComposition() {
      const queryClient = providerQueryClient;
      const [, setRevision] = useState(0);
      rerender = () => setRevision((revision) => revision + 1);
      const repairProjectCatalog = useCallback(
        (projectId: string) =>
          queryClient.invalidateQueries({
            queryKey: ["projects", projectId, "context-catalog"],
          }),
        [queryClient],
      );
      return (
        <TestAccountProvider accountId="account-a" repairProjectCatalog={repairProjectCatalog}>
          <Child />
        </TestAccountProvider>
      );
    }

    await withReactRoot(<AuthenticatedComposition />, async () => {
      const first = instances.at(-1);
      await act(async () => rerender?.());
      expect(instances.at(-1)).toBe(first);
    });
  });

  it("reuses one coordinator through Strict effect replay", async () => {
    const instances: ContextRemovalCoordinator[] = [];
    function Child() {
      const coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        instances.push(coordinator);
        coordinator.beginRouteSelection("project-1", {
          scheme: "kb",
          path: "/strict.md",
          workId: "work-1",
        });
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
        expect(instances).toHaveLength(2);
        expect(instances[0]).toBe(instances[1]);
        expect(instances[0]?.getProjectSnapshot("project-1").selection).toMatchObject({
          status: "candidate",
          revision: 2,
        });
      },
    );
  });

  it("constructs authority before descendants and isolates A to B to A", async () => {
    useContextTabsStore.setState({
      byProject: {
        "project-1": { tabs: [tracked("a", "/a.md")], selectedTabIdByWork: { "work-1": "a" } },
      },
      _deskHydrated: true,
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
          { readSearch: () => ({ screen: "context" }), updateSearch: () => undefined },
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
          owner: { kind: "desk", documentId: "a" },
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
