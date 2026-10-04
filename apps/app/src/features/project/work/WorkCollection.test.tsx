// @vitest-environment jsdom
/**
 * Work list lifecycle: Archive and Unarchive move rows at once and failures stay
 * on the Work, shared with the Work band; a restoring Work waits in the tab it
 * returns to; each deleted Work keeps its own Undo row or failure.
 */
import type { Work } from "@meridian/contracts/works";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveWork, deleteWork, listProjectWorks, restoreWork } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { deferred, snapshot, WORK } from "@/test-support/works-fixtures";
import type { WorksView } from "../routing/project-address";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { useWorkChrome } from "./useWorkChrome";
import { useWorkDeletion, type WorkDeletion } from "./useWorkDeletion";
import { WorkCollection } from "./WorkCollection";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/client/query/useProjectCreation", () => ({
  useIsProjectPendingCreation: () => false,
}));
vi.mock("@/client/api/projects-api", () => ({
  archiveWork: vi.fn(),
  createProjectWork: vi.fn(),
  deleteWork: vi.fn(),
  listProjectWorks: vi.fn(),
  restoreWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

beforeEach(() => notifyManager.setScheduler(queueMicrotask));
afterEach(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)));

const PROJECT_ID = WORK.projectId;

const CODA = { ...WORK, id: "00000000-0000-4000-8000-000000000002", name: "Coda" } as Work;
const NO_ROUTE_WORK: RouteWorkResolution = { status: "none" };

function CollectionHarness({
  initialView = "active",
  bandWorkId,
}: {
  initialView?: WorksView;
  /** Also renders the Work band for this Work, as the pane chrome does. */
  bandWorkId?: string;
}) {
  const [view, setView] = useState<WorksView>(initialView);
  const routeCommands = {
    worksView: view,
    setWorksView: async (next: WorksView) => setView(next),
    openWork: vi.fn(),
    closeWork: vi.fn(),
    workHref: () => "/works/arc",
  } as unknown as ProjectRouteCommands;
  const deletion = useWorkDeletion(PROJECT_ID, NO_ROUTE_WORK, routeCommands);
  return (
    <>
      {bandWorkId ? (
        <BandHarness workId={bandWorkId} routeCommands={routeCommands} deletion={deletion} />
      ) : null}
      <WorkCollection projectId={PROJECT_ID} routeCommands={routeCommands} deletion={deletion} />
    </>
  );
}

function BandHarness({
  workId,
  routeCommands,
  deletion,
}: {
  workId: string;
  routeCommands: ProjectRouteCommands;
  deletion: WorkDeletion;
}) {
  const work = useWorks(PROJECT_ID).works?.find((entry) => entry.id === workId);
  const routeWork = (
    work ? { status: "present", workId, work } : { status: "none" }
  ) as RouteWorkResolution;
  const chrome = useWorkChrome(PROJECT_ID, routeWork, null, routeCommands, deletion, "tab");
  return <header data-testid="band">{chrome.notice}</header>;
}

const tab = (view: WorksView) =>
  document.querySelector<HTMLButtonElement>(`[data-tab-value="${view}"]`) as HTMLButtonElement;

async function showTab(view: WorksView) {
  await act(async () => tab(view).click());
}

/** Names of the Work rows in the visible list. */
const rowNames = () =>
  [...document.querySelectorAll("li a div[aria-hidden]")].map((node) => node.textContent);

const band = () => document.querySelector('[data-testid="band"]');
const listAlerts = () =>
  [...document.querySelectorAll('li [role="alert"]')].map((node) => node.textContent);

async function fromMenu(name: string, action: "Archive" | "Delete Work") {
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
    (node) => node.textContent === action,
  );
  if (!item) throw new Error(`${action} menu item did not open`);
  await act(async () => item.click());
}
const archiveFromMenu = (name: string) => fromMenu(name, "Archive");
const deleteFromMenu = (name: string) => fromMenu(name, "Delete Work");

/** The visible Undo rows, by their text. */
const undoRows = () =>
  [...document.querySelectorAll('li [role="status"]')]
    .map((node) => node.textContent ?? "")
    .filter((text) => text.startsWith("Deleted"));

const clickIn = async (root: Element | null | undefined, label: string) => {
  const button = [...(root?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} button`);
  await act(async () => button.click());
};

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
          <CollectionHarness bandWorkId={WORK.id} />
        </QueryClientProvider>,
        async () => {
          expect(rowNames()).toEqual(["Arc"]);
          await archiveFromMenu("Arc");

          // Query cache notifications flush on a timer, outside the act() scope.
          await act(async () => {});
          expect(document.body.textContent).toContain("Start a Work");
          expect(document.activeElement).toBe(tab("archived"));
          await showTab("archived");
          expect(rowNames()).toEqual(["Arc"]);

          await act(async () => {
            first.reject(new Error("Rejected"));
            await first.promise.catch(() => undefined);
          });
          await act(async () => {});
          expect(document.body.textContent).toContain("No archived Work.");
          await showTab("active");
          expect(rowNames()).toEqual(["Arc"]);
          const alert = document.querySelector('[role="alert"]');
          expect(alert?.textContent).toContain("Work couldn’t be archived");
          expect(band()?.textContent).toContain("Work couldn’t be archived");

          const archived = { ...WORK, status: null, archivedAt: "2026-09-02T00:00:00.000Z" };
          vi.mocked(archiveWork).mockImplementationOnce(async () => {
            server = snapshot([archived as Work], "2");
            return archived as Work;
          });
          const retry = [...(band()?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Retry",
          );
          await act(async () => retry?.click());
          await act(async () => {});
          expect(document.body.textContent).toContain("Start a Work");
          expect(archiveWork).toHaveBeenCalledTimes(2);
          expect(archiveWork).toHaveBeenLastCalledWith(WORK.id, expect.anything());
          expect(document.querySelector('[role="alert"]')).toBeNull();
          expect(band()?.textContent).toBe("");
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

describe("Work collection delete", () => {
  it("undoes one delete while the other Undo row stays, and dismisses it", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let server = snapshot([WORK, CODA]);
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), server);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    const deletedAt = new Date().toISOString();
    const gone = (work: Work) => ({ ...work, deletedAt }) as Work;
    vi.mocked(deleteWork).mockImplementation(async (id) => {
      server = snapshot(
        server.works.map((work) => (work.id === id ? gone(work) : work)),
        String(Number(server.authorityRevision) + 1),
      );
    });
    const restore = deferred<Work>();
    vi.mocked(restoreWork).mockImplementation(() => restore.promise);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          await deleteFromMenu("Arc");
          await act(async () => {});
          expect(rowNames()).toEqual(["Coda"]);
          await deleteFromMenu("Coda");
          await act(async () => {});
          expect(deleteWork).toHaveBeenCalledTimes(2);
          await act(async () => {});
          expect(server.authorityRevision).toBe("3");
          await act(async () => {});
          expect(undoRows()).toEqual(["Deleted CodaUndo", "Deleted ArcUndo"]);
          // The Deleted tab leaves Works offered for Undo to their Undo rows.
          await showTab("deleted");
          expect(document.querySelector('[aria-label="Restore Arc"]')).toBeNull();
          await showTab("active");

          const arcUndo = document.querySelectorAll('li [role="status"]')[1];
          await clickIn(arcUndo, "Undo");
          expect(restoreWork).toHaveBeenCalledWith(WORK.id, expect.anything());
          await act(async () => {});
          expect(rowNames()).toEqual(["Arc"]);
          expect(undoRows()).toEqual(["Deleted CodaUndo"]);

          // A rejected Undo reopens that Work's Undo row with the error.
          await act(async () => restore.reject(new Error("Rejected")));
          await act(async () => {});
          expect(undoRows()).toEqual(["Deleted CodaUndo", "Deleted ArcUndo"]);
          expect(listAlerts()).toEqual([expect.stringContaining("Couldn’t restore this Work")]);

          await clickIn(document.querySelectorAll('li [role="status"]')[0], "Dismiss");
          await act(async () => {});
          expect(undoRows()).toEqual(["Deleted ArcUndo"]);
          await showTab("deleted");
          expect(document.querySelector('[aria-label="Restore Coda"]')).not.toBeNull();
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});
