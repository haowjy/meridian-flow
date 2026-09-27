// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type ProjectCreationRecord,
  pendingProject,
  removeProjectCreation,
  writeProjectCreation,
} from "./project-creation-cache";
import { useIsProjectPendingCreation } from "./useProjectCreation";

function PendingProbe({ projectId }: { projectId: string }) {
  return <output>{String(useIsProjectPendingCreation(projectId))}</output>;
}

function creationRecord(projectId: string): ProjectCreationRecord {
  return {
    id: projectId,
    title: "A new project",
    project: pendingProject(projectId, "A new project", "writer-1"),
    accountSignal: new AbortController().signal,
    status: "pending",
    error: null,
  };
}

describe("useIsProjectPendingCreation", () => {
  it("is not pending when the optional Query client is unavailable", async () => {
    await withReactRoot(<PendingProbe projectId="project-1" />, async () => {
      expect(document.querySelector("output")?.textContent).toBe("false");
    });
  });

  it("tracks creation records in the Query cache", async () => {
    const projectId = "project-2";
    const queryClient = new QueryClient();

    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <PendingProbe projectId={projectId} />
      </QueryClientProvider>,
      async () => {
        expect(document.querySelector("output")?.textContent).toBe("false");

        await act(async () => {
          writeProjectCreation(queryClient, creationRecord(projectId));
        });
        expect(document.querySelector("output")?.textContent).toBe("true");

        await act(async () => {
          removeProjectCreation(queryClient, projectId);
        });
        expect(document.querySelector("output")?.textContent).toBe("false");
      },
    );

    queryClient.clear();
  });
});
