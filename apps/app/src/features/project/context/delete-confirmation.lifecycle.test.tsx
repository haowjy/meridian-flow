// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const deleted = vi.fn(async () => ({ status: "deleted" as const }));

vi.mock("@/client/api/projects-api", () => ({ deleteContextEntry: deleted }));

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
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
    async () => {
      act(() => confirmation?.requestDelete({ name: "same.md", path: "/same.md", kind: "file" }));
      await act(async () => changeWork?.("work-b"));
      await act(async () => confirmation?.confirm());
    },
  );

  expect(deleted).toHaveBeenCalledWith(
    "project",
    "scratch",
    { path: "/same.md", workId: "work-a" },
    { workId: "work-a" },
  );
});
