import { act, StrictMode, useLayoutEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  configureContextRemovalAccount,
  contextRemovalCoordinator,
} from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";
import { useContextRemovalProject } from "./use-context-removal-project";

function SettlingHost({ projectId }: { projectId: string }) {
  const snapshot = useContextRemovalProject(projectId);
  useLayoutEffect(() => {
    if (snapshot.selection.status !== "pending") return;
    contextRemovalCoordinator.bindRouteSelection(projectId, snapshot.selection.revision, {
      kind: "server",
      documentId: "document-1",
    });
  }, [projectId, snapshot.selection]);
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

describe.each([
  ["normal", (node: React.ReactNode) => node],
  ["Strict Mode", (node: React.ReactNode) => <StrictMode>{node}</StrictMode>],
])("ProjectContextRemovalController in %s", (_label, wrap) => {
  it("publishes the parent-started revision so the child settles on first mount", async () => {
    configureContextRemovalAccount(`account-${_label}`);
    const projectId = `project-${_label}`;
    await withReactRoot(
      wrap(
        <ProjectContextRemovalController
          projectId={projectId}
          activeScreen="context"
          activeContextScheme="manuscript"
          activeContextPath="/chapter.md"
          editorWorkId="work-1"
          route={route}
        >
          <SettlingHost projectId={projectId} />
        </ProjectContextRemovalController>,
      ),
      () => {
        expect(contextRemovalCoordinator.getProjectSnapshot(projectId).selection).toMatchObject({
          status: "bound",
          locator: { path: "/chapter.md", workId: "work-1" },
          selection: { documentId: "document-1" },
        });
      },
    );
  });
});

describe("ProjectContextRemovalController lifecycle", () => {
  it("does not prune Work tabs until a ready non-null Work exists", async () => {
    const projectId = "project-work-readiness";
    useContextTabsStore.setState({
      byProject: {
        [projectId]: {
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
    let setWork: ((workId: string | null) => void) | null = null;
    function Harness() {
      const [workId, updateWork] = useState<string | null>(null);
      setWork = updateWork;
      return (
        <ProjectContextRemovalController
          projectId={projectId}
          activeScreen="home"
          activeContextScheme={null}
          activeContextPath={null}
          editorWorkId={workId}
          route={route}
        >
          <div />
        </ProjectContextRemovalController>
      );
    }

    await withReactRoot(<Harness />, async () => {
      expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);
      await act(async () => setWork?.("work-2"));
      expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(0);
    });
  });

  it("fully disposes a subscribed project and does not allocate snapshots for absences", async () => {
    const projectId = "project-subscribed-disposal";
    function Subscriber() {
      useContextRemovalProject(projectId);
      return null;
    }

    await withReactRoot(
      <ProjectContextRemovalController
        projectId={projectId}
        activeScreen="home"
        activeContextScheme={null}
        activeContextPath={null}
        editorWorkId="work-1"
        route={route}
      >
        <Subscriber />
      </ProjectContextRemovalController>,
    );

    const disposed = contextRemovalCoordinator.getProjectSnapshot(projectId);
    expect(disposed).toBe(contextRemovalCoordinator.getProjectSnapshot("never-mounted"));
    configureContextRemovalAccount("account-after-disposal");
    expect(contextRemovalCoordinator.getProjectSnapshot(projectId)).toBe(disposed);
  });
});
