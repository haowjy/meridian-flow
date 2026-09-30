// @vitest-environment jsdom
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { listProjectWorks, updateWork } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { WorkHeading, WorkTitleTab } from "./WorkTitles";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/client/query/useProjectCreation", () => ({
  useIsProjectPendingCreation: () => false,
}));
vi.mock("@/client/api/projects-api", () => ({
  archiveWork: vi.fn(),
  deleteWork: vi.fn(),
  listProjectWorks: vi.fn(),
  restoreWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

const PROJECT_ID = "project-1";
const WORK = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: PROJECT_ID,
  createdByUserId: "user-1",
  name: "Arc",
  slug: "arc",
  isNoWork: false,
  goal: null,
  status: null,
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
} as Work;
const SNAPSHOT = {
  projectId: PROJECT_ID,
  catalogGeneration: "1",
  authorityRevision: "1",
  requestId: "request-1",
  works: [WORK],
  noWork: { ...WORK, id: "no-work", name: "No Work", isNoWork: true, slug: null },
} as unknown as WorksSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function TitleHarness() {
  const work = useWorks(PROJECT_ID).works?.[0];
  if (!work) return null;
  return (
    <>
      <WorkTitleTab projectId={PROJECT_ID} work={work} variant="tab" />
      <WorkHeading projectId={PROJECT_ID} work={work} />
    </>
  );
}

function setValue(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Work title rename", () => {
  it("updates both titles before confirmation and keeps failure on the title used", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), SNAPSHOT);
    const request = deferred<Work>();
    const started = deferred<void>();
    vi.mocked(updateWork).mockImplementation(() => {
      started.resolve();
      return request.promise;
    });
    vi.mocked(listProjectWorks).mockResolvedValue(SNAPSHOT);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <TitleHarness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            document.querySelector<HTMLButtonElement>('[aria-label="Rename Work: Arc"]')?.click();
          });
          const input = document.querySelector<HTMLInputElement>('input[aria-label="Rename Work"]');
          if (!input) throw new Error("Work tab title field did not open");
          await act(async () => {
            setValue(input, "Revised arc");
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            await started.promise;
          });

          // Query cache notifications flush on a timer, outside the act() scope.
          await act(() =>
            vi.waitFor(() =>
              expect(
                [...document.querySelectorAll("button")].filter(
                  (button) => button.textContent === "Revised arc",
                ),
              ).toHaveLength(2),
            ),
          );

          await act(async () => {
            request.reject(new Error("Rejected"));
            await new Promise((resolve) => setTimeout(resolve, 0));
          });

          expect(
            document.querySelector<HTMLInputElement>('input[aria-label="Rename Work"]')?.value,
          ).toBe("Revised arc");
          expect(document.body.textContent).toContain("Couldn’t rename this Work. Try again.");
          await act(() =>
            vi.waitFor(() =>
              expect(
                [...document.querySelectorAll("button")].filter(
                  (button) => button.textContent === "Arc",
                ),
              ).toHaveLength(1),
            ),
          );
        },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});
