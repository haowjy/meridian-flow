// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";

const { deleted } = vi.hoisted(() => ({
  deleted: vi.fn(async () => ({
    status: "deleted" as const,
    deletedDocumentIds: ["document-a"],
  })),
}));

vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  deleteContextEntry: deleted,
}));

const { useDeleteConfirmation } = await import("./ContextEntryActions");

type Confirmation = ReturnType<typeof useDeleteConfirmation>;
let confirmation: Confirmation | null = null;
let changeWork: ((workId: string) => void) | null = null;

function Harness() {
  const [workId, setWorkId] = useState("work-a");
  changeWork = setWorkId;
  confirmation = useDeleteConfirmation({ projectId: "project", workId, scheme: "scratch" });
  return null;
}

it("submits the Work captured when delete confirmation was requested", async () => {
  const queryClient = new QueryClient();
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "document-a",
            scheme: "scratch",
            path: "/same.md",
            name: "same.md",
            workId: "work-a",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
          {
            kind: "tracked",
            documentId: "document-b",
            scheme: "scratch",
            path: "/other.md",
            name: "other.md",
            workId: "work-a",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        activeTabId: "document-b",
      },
    },
    _deskHydrated: true,
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
    async () => {
      act(() =>
        confirmation?.requestDelete({
          name: "same.md",
          path: "/same.md",
          kind: "file",
          documentId: "document-same",
        }),
      );
      await act(async () => changeWork?.("work-b"));
      await act(async () => confirmation?.confirm());
    },
  );

  expect(deleted).toHaveBeenCalledWith(
    "project",
    "scratch",
    {
      path: "/same.md",
      expected: { kind: "file", documentId: "document-same" },
    },
    { workId: "work-a" },
  );
  expect(useContextTabsStore.getState().byProject.project?.tabs).toMatchObject([
    { documentId: "document-b" },
  ]);

  queryClient.setQueryData(["projects", "project", "context-tree"], { tree: null });
  expect(useContextTabsStore.getState().byProject.project?.tabs).toMatchObject([
    { documentId: "document-b" },
  ]);
});
