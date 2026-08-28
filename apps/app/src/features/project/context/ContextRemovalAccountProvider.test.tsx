// @vitest-environment jsdom
import { act, useLayoutEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
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
      expect(entrySnapshots.slice(1)).toEqual([
        expect.objectContaining({
          selection: { status: "none", revision: 0 },
          rememberedRoute: null,
          removalFence: null,
        }),
        expect.objectContaining({
          selection: { status: "none", revision: 0 },
          rememberedRoute: null,
          removalFence: null,
        }),
      ]);
    });
  });

  it("makes the disposed account instance inert before delayed callbacks reach global stores", async () => {
    let setAccount: ((accountId: string) => void) | null = null;
    let oldCoordinator: ContextRemovalCoordinator | null = null;
    let delayedCommand:
      | Parameters<ContextRemovalCoordinator["acceptAcknowledgedDelete"]>[0]
      | null = null;
    const oldListener = vi.fn();

    function Child({ accountId }: { accountId: string }) {
      const coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        if (accountId !== "account-a") return;
        oldCoordinator = coordinator;
        coordinator.subscribe("project-1", oldListener);
        const revision = coordinator.beginRouteSelection("project-1", {
          scheme: "manuscript",
          path: "/a.md",
          workId: "work-1",
        });
        coordinator.bindRouteSelection("project-1", revision, {
          kind: "server",
          documentId: "a",
        });
        delayedCommand = {
          ...coordinator.captureDeleteInitiation("project-1", {
            kind: "file",
            locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
            documentId: "a",
          }),
          cause: "acknowledged-delete",
          confirmed: { status: "deleted", deletedDocumentIds: ["a"] },
        };
      }, [accountId, coordinator]);
      return null;
    }
    function Harness() {
      const [accountId, updateAccount] = useState("account-a");
      setAccount = updateAccount;
      return (
        <ContextRemovalAccountProvider key={accountId} accountId={accountId}>
          <Child accountId={accountId} />
        </ContextRemovalAccountProvider>
      );
    }

    useContextTabsStore.setState({
      byProject: { "project-1": { tabs: [tracked("a", "/a.md")], activeTabId: "a" } },
      _deskHydrated: true,
    });
    await withReactRoot(<Harness />, async () => {
      await act(async () => setAccount?.("account-b"));
      useContextTabsStore.setState({
        byProject: { "project-1": { tabs: [tracked("b", "/b.md")], activeTabId: "b" } },
        _deskHydrated: true,
      });
      oldListener.mockClear();
      const service = oldCoordinator;
      const command = delayedCommand;
      if (!service || !command) throw new Error("old command was not captured");

      expect(service.acceptAcknowledgedDelete(command)).toEqual({
        status: "rejected",
        reason: "coordinator_disposed",
      });
      service.applyDraftMetadata("project-1", "work-1", "b");
      expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
        tabs: [{ documentId: "b" }],
        activeTabId: "b",
      });
      expect(oldListener).not.toHaveBeenCalled();
    });
  });
});
