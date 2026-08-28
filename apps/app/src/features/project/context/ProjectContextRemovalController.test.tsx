import { act, useLayoutEffect, useState } from "react";
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

  it.each([
    "home",
    "chat",
    "work",
  ] as const)("uses an ordinary same-Work leave and return through %s", async (offScreen) => {
    useContextTabsStore.setState({
      byProject: {
        "project-1": {
          tabs: [
            {
              kind: "tracked",
              documentId: "document-1",
              scheme: "manuscript",
              path: "/chapter.md",
              name: "chapter.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
            {
              kind: "tracked",
              documentId: "removed",
              scheme: "manuscript",
              path: "/removed.md",
              name: "removed.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
          ],
          activeTabId: "document-1",
        },
      },
      _deskHydrated: true,
    });
    let coordinator: ContextRemovalCoordinator | null = null;
    let setScreen: ((screen: "context" | typeof offScreen) => void) | null = null;
    function Capture() {
      coordinator = useContextRemovalCoordinator();
      return null;
    }
    function Harness() {
      const [screen, updateScreen] = useState<"context" | typeof offScreen>("context");
      setScreen = updateScreen;
      return (
        <ContextRemovalAccountProvider accountId="account-1">
          <Capture />
          <ProjectContextRemovalController
            projectId="project-1"
            activeScreen={screen}
            activeContextScheme={screen === "context" ? "manuscript" : null}
            activeContextPath={screen === "context" ? "/chapter.md" : null}
            editorWorkId="work-1"
            route={route}
          />
          <SettlingHost projectId="project-1" />
        </ContextRemovalAccountProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      const initial = coordinator?.getProjectSnapshot("project-1");
      expect(initial).toMatchObject({
        selection: { status: "bound" },
        rememberedRoute: { path: "/chapter.md", workId: "work-1" },
        live: true,
      });

      await act(async () => setScreen?.(offScreen));
      const left = coordinator?.getProjectSnapshot("project-1");
      expect(left).toMatchObject({
        selection: { status: "none" },
        rememberedRoute: { path: "/chapter.md", workId: "work-1" },
        live: true,
      });
      coordinator?.writerClose("project-1", "removed");
      const removed = coordinator?.getProjectSnapshot("project-1");
      expect(removed).toMatchObject({
        selection: { status: "none" },
        rememberedRoute: { path: "/chapter.md", workId: "work-1" },
        removalFence: { removedDocumentIds: ["removed"] },
        live: true,
      });

      await act(async () => setScreen?.("context"));
      expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
        selection: {
          status: "bound",
          revision: expect.any(Number),
          locator: { path: "/chapter.md", workId: "work-1" },
        },
        rememberedRoute: { path: "/chapter.md", workId: "work-1" },
        live: true,
      });
      expect(coordinator?.getProjectSnapshot("project-1").selection.revision).toBeGreaterThan(
        left?.selection.revision ?? 0,
      );
    });
  });

  it("disposes account state on provider release", async () => {
    let coordinator: ContextRemovalCoordinator | null = null;
    function Capture() {
      coordinator = useContextRemovalCoordinator();
      useLayoutEffect(() => {
        const revision = coordinator?.beginRouteSelection("project-1", {
          scheme: "manuscript",
          path: "/chapter.md",
          workId: "work-1",
        });
        if (revision !== undefined) {
          coordinator?.bindRouteSelection("project-1", revision, {
            kind: "server",
            documentId: "document-1",
          });
        }
      }, []);
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

  it("releases the host without destroying account-owned project revision", async () => {
    let coordinator: ContextRemovalCoordinator | null = null;
    let setHostVisible: ((visible: boolean) => void) | null = null;
    function Capture() {
      coordinator = useContextRemovalCoordinator();
      return null;
    }
    function Harness() {
      const [hostVisible, updateHostVisible] = useState(true);
      setHostVisible = updateHostVisible;
      return (
        <ContextRemovalAccountProvider accountId="account-1">
          <Capture />
          {hostVisible ? (
            <>
              <ProjectContextRemovalController
                projectId="project-1"
                activeScreen="context"
                activeContextScheme="manuscript"
                activeContextPath="/chapter.md"
                editorWorkId="work-1"
                route={route}
              />
              <SettlingHost projectId="project-1" />
            </>
          ) : null}
        </ContextRemovalAccountProvider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      const before = coordinator?.getProjectSnapshot("project-1").selection.revision ?? 0;
      expect(before).toBeGreaterThan(0);
      await act(async () => setHostVisible?.(false));
      expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
        selection: { status: "none", revision: expect.any(Number) },
        live: false,
      });
      expect(coordinator?.getProjectSnapshot("project-1").selection.revision).toBeGreaterThan(
        before,
      );
    });
  });
});
