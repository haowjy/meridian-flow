// @vitest-environment jsdom
/** Work list lifecycle: Archive and Unarchive move rows at once; failures stay on the Work. */
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { archiveWork, listProjectWorks } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { WorksView } from "../routing/project-address";
import type { ProjectRouteCommands } from "../routing/project-route";
import type { WorkDeletion } from "./useWorkDeletion";
import { WorkCollection } from "./WorkCollection";
import { emptyWorkDeleteState } from "./work-delete-state";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${part}${values[index] ?? ""}`, ""),
  plural: (count: number, forms: { other: string }) => forms.other.replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/client/query/useProjectCreation", () => ({
  useIsProjectPendingCreation: () => false,
}));
vi.mock("./useWorkCreation", () => ({ useWorkCreationRecords: () => [] }));
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
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
} as Work;
const snapshot = (works: Work[], authorityRevision = "1") =>
  ({
    projectId: PROJECT_ID,
    catalogGeneration: "1",
    authorityRevision,
    requestId: "request-1",
    works,
    noWork: { ...WORK, id: "no-work", name: "No Work", isNoWork: true, slug: null },
  }) as unknown as WorksSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const deletion: WorkDeletion = {
  state: emptyWorkDeleteState(),
  remove: vi.fn(),
  retry: vi.fn(),
  undo: vi.fn(),
  dismiss: vi.fn(),
};

function CollectionHarness() {
  const [view, setView] = useState<WorksView>("active");
  const routeCommands = {
    worksView: view,
    setWorksView: async (next: WorksView) => setView(next),
    openWork: vi.fn(),
    workHref: () => "/works/arc",
  } as unknown as ProjectRouteCommands;
  return (
    <WorkCollection projectId={PROJECT_ID} routeCommands={routeCommands} deletion={deletion} />
  );
}

const tab = (view: WorksView) =>
  document.querySelector<HTMLButtonElement>(`[data-tab-value="${view}"]`) as HTMLButtonElement;

async function showTab(view: WorksView) {
  await act(async () => tab(view).click());
}

/** Names of the Work rows in the visible list. */
const rowNames = () =>
  [...document.querySelectorAll("li a span[aria-hidden]")].map((node) => node.textContent);

async function archiveFromMenu(name: string) {
  const trigger = document.querySelector(`[aria-label="Actions for ${name}"]`) as HTMLButtonElement;
  await act(async () => {
    const PointerEventConstructor = window.PointerEvent ?? window.MouseEvent;
    trigger.dispatchEvent(
      new PointerEventConstructor("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      } as PointerEventInit),
    );
    trigger.click();
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent === "Archive",
  );
  if (!item) throw new Error("Archive menu item did not open");
  await act(async () => item.click());
}

describe("Work collection archive", () => {
  it("moves the row before the server answers, returns it with an error on failure, and retries", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let server = snapshot([WORK]);
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), server);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    const first = deferred<Work>();
    vi.mocked(archiveWork).mockImplementationOnce(() => first.promise);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          expect(rowNames()).toEqual(["Arc"]);
          await archiveFromMenu("Arc");

          // Query cache notifications flush on a timer, outside the act() scope.
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("No active Work yet.")),
          );
          expect(document.activeElement).toBe(tab("archived"));
          await showTab("archived");
          expect(rowNames()).toEqual(["Arc"]);

          await act(async () => {
            first.reject(new Error("Rejected"));
            await first.promise.catch(() => undefined);
          });
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("No archived Work.")),
          );
          await showTab("active");
          expect(rowNames()).toEqual(["Arc"]);
          const alert = document.querySelector('[role="alert"]');
          expect(alert?.textContent).toContain("Work couldn’t be archived");

          const archived = { ...WORK, status: "archived", archivedAt: "2026-09-02T00:00:00.000Z" };
          vi.mocked(archiveWork).mockImplementationOnce(async () => {
            server = snapshot([archived as Work], "2");
            return archived as Work;
          });
          const retry = [...(alert?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Retry",
          );
          await act(async () => retry?.click());
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("No active Work yet.")),
          );
          expect(archiveWork).toHaveBeenCalledTimes(2);
          expect(archiveWork).toHaveBeenLastCalledWith(WORK.id);
          expect(document.querySelector('[role="alert"]')).toBeNull();
          await showTab("archived");
          expect(rowNames()).toEqual(["Arc"]);
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});
