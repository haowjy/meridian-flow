import { act, useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";
import { useContextRemovalProject } from "./use-context-removal-project";

function SettlingHost({ projectId }: { projectId: string }) {
  const snapshot = useContextRemovalProject(projectId);
  const coordinator = useContextRemovalCoordinator();
  useLayoutEffect(() => {
    if (snapshot.selection.status !== "pending") return;
    coordinator.bindRouteSelection(projectId, snapshot.selection.revision, {
      kind: "server",
      documentId: "document-1",
    });
  }, [coordinator, projectId, snapshot.selection]);
  return null;
}

const route = {
  readSearch: () => ({
    screen: "context" as const,
    work: "work-1",
    scheme: "manuscript" as const,
    path: "/chapter.md",
  }),
  updateSearch: () => undefined,
};

describe("ProjectContextRemovalController", () => {
  it("registers and begins before its later sibling settles", async () => {
    let observed: ReturnType<
      ReturnType<typeof useContextRemovalCoordinator>["getProjectSnapshot"]
    > | null = null;
    function Observer() {
      const coordinator = useContextRemovalCoordinator();
      observed = useContextRemovalProject("project-1");
      useLayoutEffect(() => {
        observed = coordinator.getProjectSnapshot("project-1");
      });
      return null;
    }
    await withReactRoot(
      <ContextRemovalAccountProvider accountId="account-1">
        <ProjectContextRemovalController
          projectId="project-1"
          activeScreen="context"
          activeContextScheme="manuscript"
          activeContextPath="/chapter.md"
          editorWorkId="work-1"
          route={route}
        />
        <SettlingHost projectId="project-1" />
        <Observer />
      </ContextRemovalAccountProvider>,
      () => {
        expect(observed?.selection).toMatchObject({
          status: "bound",
          locator: { path: "/chapter.md", workId: "work-1" },
          identity: { documentId: "document-1" },
        });
      },
    );
  });

  it("prunes Work tabs during the live layout transition", async () => {
    useContextTabsStore.setState({
      byProject: {
        "project-1": {
          tabs: [
            {
              kind: "tracked",
              documentId: "scratch-1",
              scheme: "scratch",
              path: "/note.md",
              name: "note.md",
              workId: "work-1",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
          ],
          activeTabId: "scratch-1",
        },
      },
      _deskHydrated: true,
    });
    await withReactRoot(
      <ContextRemovalAccountProvider accountId="account-1">
        <ProjectContextRemovalController
          projectId="project-1"
          activeScreen="home"
          activeContextScheme={null}
          activeContextPath={null}
          editorWorkId="work-2"
          route={route}
        />
      </ContextRemovalAccountProvider>,
      async () => {
        await act(async () => undefined);
        expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toHaveLength(0);
      },
    );
  });

  it("disposes account state on provider release", async () => {
    let coordinator: ContextRemovalCoordinator | null = null;
    function Capture() {
      coordinator = useContextRemovalCoordinator();
      return null;
    }
    await withReactRoot(
      <ContextRemovalAccountProvider accountId="account-1">
        <Capture />
      </ContextRemovalAccountProvider>,
      () => undefined,
    );
    if (!coordinator) throw new Error("expected coordinator");
    expect(
      (coordinator as ContextRemovalCoordinator).getProjectSnapshot("project-1").selection,
    ).toEqual({
      status: "none",
      revision: 0,
    });
  });
});
