// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextRemovalAccountProvider } from "./ContextRemovalAccountProvider";

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

beforeEach(() => {
  confirmation = null;
  changeWork = null;
  deleted.mockClear();
});

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
        selectedTabIdByWork: { "work-1": "document-b" },
      },
    },
    _deskHydrated: true,
  });
  const invalidation = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {
    expect(
      useContextTabsStore
        .getState()
        .byProject.project?.tabs.some((tab) => tab.documentId === "document-a"),
    ).toBe(false);
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ContextRemovalAccountProvider accountId="account-1">
        <Harness />
      </ContextRemovalAccountProvider>
    </QueryClientProvider>,
    async () => {
      act(() =>
        confirmation?.requestDelete({
          name: "same.md",
          path: "/same.md",
          kind: "file",
          documentId: "document-a",
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
      expected: { kind: "file", documentId: "document-a" },
    },
    { workId: "work-a" },
  );
  expect(invalidation).toHaveBeenCalledOnce();
  expect(invalidation).toHaveBeenCalledWith({
    queryKey: projectQueryKeys.contextTree("project", "scratch", "work-a"),
  });
  expect(useContextTabsStore.getState().byProject.project?.tabs).toMatchObject([
    { documentId: "document-b" },
  ]);
});

it("keeps a stale-target confirmation open with a retry error", async () => {
  const staleTarget = new MeridianApiError({
    code: "stale_target",
    message: "The context entry changed. Refresh and try again.",
    retryable: true,
    source: "system",
  });
  deleted.mockRejectedValueOnce(staleTarget);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <ContextRemovalAccountProvider accountId="account-1">
        <Harness />
      </ContextRemovalAccountProvider>
    </QueryClientProvider>,
    async () => {
      act(() =>
        confirmation?.requestDelete({
          name: "changed.md",
          path: "/changed.md",
          kind: "file",
          documentId: "old-document",
        }),
      );
      await act(async () => confirmation?.confirm());
      expect(confirmation?.target).toMatchObject({ documentId: "old-document" });
      await vi.waitFor(() => expect(confirmation?.error).toBe(staleTarget));
    },
  );
});
