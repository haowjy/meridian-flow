import { StrictMode, useLayoutEffect } from "react";
import { describe, expect, it } from "vitest";
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
