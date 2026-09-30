// @vitest-environment jsdom
/**
 * Work list lifecycle: Archive and Unarchive move rows at once and failures stay
 * on the Work, shared with the Work band; a restoring Work waits in the tab it
 * returns to; each deleted Work keeps its own Undo row or failure.
 */
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  archiveWork,
  createProjectWork,
  deleteWork,
  listProjectWorks,
  restoreWork,
} from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useWorks } from "@/client/query/useWorks";
import { useWorkMutations } from "@/client/query/work-command-store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { WorksView } from "../routing/project-address";
import type { ProjectRouteCommands, RouteWorkResolution } from "../routing/project-route";
import { useWorkChrome } from "./useWorkChrome";
import { useWorkDeletion, type WorkDeletion } from "./useWorkDeletion";
import { WorkCollection } from "./WorkCollection";

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

let createWork!: ReturnType<typeof useWorkMutations>["create"];
function CommandHarness() {
  createWork = useWorkMutations(PROJECT_ID).create;
  return null;
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
  it("lists archived Works under Archived, each with its status beside its name", async () => {
    const client = new QueryClient();
    const works = [
      { ...WORK, status: "Drafting" },
      { ...CODA, status: null },
      {
        ...WORK,
        id: "00000000-0000-4000-8000-000000000003",
        name: "Epilogue",
        status: "Done",
        archivedAt: "2026-09-02T00:00:00.000Z",
      },
    ] as Work[];
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot(works));
    vi.mocked(listProjectWorks).mockImplementation(async () => snapshot(works));
    const rowLinks = () =>
      [...document.querySelectorAll("li a .sr-only")].map((node) => node.textContent);
    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          expect(rowLinks()).toEqual(["Open Arc (Drafting)", "Open Coda"]);
          expect(document.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
          await showTab("archived");
          expect(rowLinks()).toEqual(["Open Epilogue (Done)"]);
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });

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
            vi.waitFor(() => expect(document.body.textContent).toContain("Start a Work")),
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

          const archived = { ...WORK, status: null, archivedAt: "2026-09-02T00:00:00.000Z" };
          vi.mocked(archiveWork).mockImplementationOnce(async () => {
            server = snapshot([archived as Work], "2");
            return archived as Work;
          });
          const retry = [...(alert?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Retry",
          );
          await act(async () => retry?.click());
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("Start a Work")),
          );
          expect(archiveWork).toHaveBeenCalledTimes(2);
          expect(archiveWork).toHaveBeenLastCalledWith(WORK.id, expect.anything());
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

describe("Work collection archive failures", () => {
  it("keeps the first failure when a second archive follows it", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([WORK, CODA]));
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    const first = deferred<Work>();
    vi.mocked(archiveWork)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => new Promise(() => undefined));

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          await archiveFromMenu("Arc");
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Coda"])));
          await archiveFromMenu("Coda");
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("Start a Work")),
          );

          await act(async () => first.reject(new Error("Rejected")));
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Arc"])));
          expect(listAlerts()).toEqual([expect.stringContaining("Work couldn’t be archived")]);
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });

  it("shows one failure in the list and the band, cleared by a retry from either", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    let server = snapshot([WORK]);
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), server);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    vi.mocked(archiveWork).mockImplementationOnce(async () => {
      throw new Error("Rejected");
    });

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness bandWorkId={WORK.id} />
        </QueryClientProvider>,
        async () => {
          await archiveFromMenu("Arc");
          await act(() =>
            vi.waitFor(() => expect(band()?.textContent).toContain("Work couldn’t be archived")),
          );
          expect(listAlerts()).toEqual([expect.stringContaining("Work couldn’t be archived")]);

          const archivedWork = {
            ...WORK,
            status: null,
            archivedAt: "2026-09-02T00:00:00.000Z",
          };
          vi.mocked(archiveWork).mockImplementationOnce(async () => {
            server = snapshot([archivedWork as Work], "2");
            return archivedWork as Work;
          });
          const bandRetry = [...(band()?.querySelectorAll("button") ?? [])].find(
            (button) => button.textContent === "Retry",
          );
          await act(async () => bandRetry?.click());
          await act(() =>
            vi.waitFor(() => expect(document.body.textContent).toContain("Start a Work")),
          );
          await act(() => vi.waitFor(() => expect(band()?.textContent).toBe("")));
          expect(document.querySelector('[role="alert"]')).toBeNull();
          expect(archiveWork).toHaveBeenCalledTimes(2);
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
  it("keeps each delete's own Undo row, and the first one's failure when the second follows", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([WORK, CODA]));
    // Snapshot reads never land: the rows come from the delete records alone.
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    const first = deferred<void>();
    vi.mocked(deleteWork)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => new Promise(() => undefined));

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          await deleteFromMenu("Arc");
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Coda"])));
          await deleteFromMenu("Coda");
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual([])));
          expect(undoRows()).toEqual(["Deleted CodaUndo", "Deleted ArcUndo"]);
          // One lifecycle scope: the second delete waits for the first on the network.
          expect(deleteWork).toHaveBeenCalledTimes(1);

          await act(async () => first.reject(new Error("Rejected")));
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Arc"])));
          expect(listAlerts()).toEqual([expect.stringContaining("Work couldn’t be deleted")]);
          expect(undoRows()).toEqual(["Deleted CodaUndo"]);
          expect(deleteWork).toHaveBeenLastCalledWith(CODA.id, expect.anything());
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });

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
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Coda"])));
          await deleteFromMenu("Coda");
          await act(() => vi.waitFor(() => expect(deleteWork).toHaveBeenCalledTimes(2)));
          await act(() => vi.waitFor(() => expect(server.authorityRevision).toBe("3")));
          await act(() =>
            vi.waitFor(() => expect(undoRows()).toEqual(["Deleted CodaUndo", "Deleted ArcUndo"])),
          );
          // The Deleted tab leaves Works offered for Undo to their Undo rows.
          await showTab("deleted");
          expect(document.querySelector('[aria-label="Restore Arc"]')).toBeNull();
          await showTab("active");

          const arcUndo = document.querySelectorAll('li [role="status"]')[1];
          await clickIn(arcUndo, "Undo");
          expect(restoreWork).toHaveBeenCalledWith(WORK.id, expect.anything());
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Arc"])));
          expect(undoRows()).toEqual(["Deleted CodaUndo"]);

          // A rejected Undo reopens that Work's Undo row with the error.
          await act(async () => restore.reject(new Error("Rejected")));
          await act(() =>
            vi.waitFor(() => expect(undoRows()).toEqual(["Deleted CodaUndo", "Deleted ArcUndo"])),
          );
          expect(listAlerts()).toEqual([expect.stringContaining("Couldn’t restore this Work")]);

          await clickIn(document.querySelectorAll('li [role="status"]')[0], "Dismiss");
          await act(() => vi.waitFor(() => expect(undoRows()).toEqual(["Deleted ArcUndo"])));
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

  it("puts an archived Work's Undo row under Archived, never under Active", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const archivedWork = {
      ...WORK,
      status: null,
      archivedAt: "2026-09-02T00:00:00.000Z",
    } as Work;
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([archivedWork]));
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    vi.mocked(deleteWork).mockImplementation(() => new Promise(() => undefined));

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness initialView="archived" />
        </QueryClientProvider>,
        async () => {
          await deleteFromMenu("Arc");
          await act(() => vi.waitFor(() => expect(undoRows()).toEqual(["Deleted ArcUndo"])));
          expect(rowNames()).toEqual([]);
          await showTab("active");
          expect(undoRows()).toEqual([]);
          expect(document.body.textContent).toContain("Start a Work");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});

describe("Work collection restore", () => {
  it("shows a refused restore on its row, with Retry and Dismiss", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const gone = { ...WORK, deletedAt: new Date().toISOString() } as Work;
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([gone]));
    vi.mocked(listProjectWorks).mockImplementation(async () => snapshot([gone]));
    const retried = deferred<Work>();
    vi.mocked(restoreWork)
      .mockRejectedValueOnce(new Error("Rejected"))
      .mockImplementationOnce(() => retried.promise);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness initialView="deleted" />
        </QueryClientProvider>,
        async () => {
          await act(async () =>
            document.querySelector<HTMLButtonElement>('[aria-label="Restore Arc"]')?.click(),
          );
          await act(() =>
            vi.waitFor(() =>
              expect(listAlerts()).toEqual([expect.stringContaining("Couldn’t restore this Work")]),
            ),
          );
          await clickIn(document.querySelector('li [role="alert"]'), "Retry");
          await act(() => vi.waitFor(() => expect(restoreWork).toHaveBeenCalledTimes(2)));
          await act(() => vi.waitFor(() => expect(listAlerts()).toEqual([])));
          await act(async () => retried.reject(new Error("Rejected")));
          await act(() => vi.waitFor(() => expect(listAlerts()).toHaveLength(1)));

          await clickIn(document.querySelector('li [role="alert"]'), "Dismiss");
          await act(() => vi.waitFor(() => expect(listAlerts()).toEqual([])));
          expect(document.querySelector('[aria-label="Restore Arc"]')).not.toBeNull();
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });

  it("shows a restoring archived Work under Archived, never under Active", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const deletedArchived = {
      ...WORK,
      status: null,
      archivedAt: "2026-09-02T00:00:00.000Z",
      deletedAt: new Date().toISOString(),
    } as Work;
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([deletedArchived]));
    vi.mocked(listProjectWorks).mockImplementation(async () => snapshot([deletedArchived]));
    const request = deferred<Work>();
    vi.mocked(restoreWork).mockImplementation(() => request.promise);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CollectionHarness initialView="deleted" />
        </QueryClientProvider>,
        async () => {
          await act(async () =>
            document.querySelector<HTMLButtonElement>('[aria-label="Restore Arc"]')?.click(),
          );
          expect(restoreWork).toHaveBeenCalledWith(WORK.id, expect.anything());

          await showTab("active");
          expect(rowNames()).toEqual([]);
          expect(document.body.textContent).not.toContain("Restoring");

          await showTab("archived");
          expect(rowNames()).toEqual(["Arc"]);
          expect(document.querySelector('[role="status"]')?.textContent).toBe("Restoring");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});

describe("Work collection create", () => {
  it("shows a Work being created, then the created Work in the same place", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([WORK]));
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    const post = deferred<Work>();
    vi.mocked(createProjectWork).mockImplementation(() => post.promise);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <CommandHarness />
          <CollectionHarness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            void createWork({ workId: CODA.id as ParsedRequestId, name: "Coda" });
          });
          await act(() => vi.waitFor(() => expect(rowNames()).toEqual(["Coda", "Arc"])));
          expect(document.querySelector('li [role="status"]')?.textContent).toBe("Creating");

          await act(async () => post.resolve(CODA));
          await act(() =>
            vi.waitFor(() => expect(document.querySelector('li [role="status"]')).toBeNull()),
          );
          expect(rowNames()).toEqual(["Coda", "Arc"]);
          expect(document.querySelector('[aria-label="Actions for Coda"]')).not.toBeNull();
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});
