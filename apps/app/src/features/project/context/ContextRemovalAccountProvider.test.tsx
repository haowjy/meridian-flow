// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";

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

describe("ContextRemovalAccountProvider", () => {
  it("constructs authority before descendants and isolates A to B to A", async () => {
    useContextTabsStore.setState({
      byProject: { "project-1": { tabs: [tracked("a", "/a.md")], activeTabId: "a" } },
      _deskHydrated: true,
    });
    const instances: ContextRemovalCoordinator[] = [];
    let setAccount: ((accountId: string) => void) | null = null;
    function Child() {
      const coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        instances.push(coordinator);
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
        });
      }, [coordinator]);
      return null;
    }
    function Harness() {
      const [accountId, updateAccount] = useState("account-a");
      setAccount = updateAccount;
      return (
        <ContextRemovalAccountProvider key={accountId} accountId={accountId}>
          <Child />
        </ContextRemovalAccountProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(instances[0]?.getProjectSnapshot("project-1").rememberedRoute?.path).toBe("/a.md");
      await act(async () => setAccount?.("account-b"));
      await act(async () => setAccount?.("account-a"));
      expect(instances).toHaveLength(3);
      expect(instances[0]).not.toBe(instances[2]);
      expect(instances[1]?.accountId).toBe("account-b");
      expect(instances[2]?.accountId).toBe("account-a");
    });
  });
});
