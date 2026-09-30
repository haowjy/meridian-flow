// @vitest-environment jsdom
/** Project route snapshots commit once per project, and once more when a created project gets its data. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import { ProjectRouteBootstrap } from "./ProjectRouteBootstrap";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  seedProjectRouteData: vi.fn(),
  hydrateWorkingSet: vi.fn((_: string, result: { status: string }) => ({ status: result.status })),
  readable: vi.fn(({ entryHydration }: { entryHydration: { status: string } }) => (
    <div data-readable={entryHydration.status} />
  )),
}));

vi.mock("@/client/query/project-route-data", () => ({
  seedProjectRouteData: mocks.seedProjectRouteData,
}));

vi.mock("@/client/working-set", () => ({
  hydrateWorkingSet: mocks.hydrateWorkingSet,
}));

vi.mock("./ReadableProjectRoute", () => ({
  ReadableProjectRoute: mocks.readable,
}));

const project = {
  id: "00000000-0000-4000-8000-000000000020",
  userId: "00000000-0000-4000-8000-000000000021",
} as Project;

function routeData(worksStarted: number): ProjectRouteData {
  return {
    threads: [],
    works: null,
    worksStarted,
    workingSet: { status: "absent" },
  };
}

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient();
  mocks.seedProjectRouteData.mockClear();
  mocks.hydrateWorkingSet.mockClear();
  mocks.readable.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ProjectRouteBootstrap", () => {
  it("does not re-adopt loader echoes for the same mounted project", async () => {
    const render = (data: ProjectRouteData) =>
      root.render(
        <QueryClientProvider client={client}>
          <ProjectRouteBootstrap
            project={project}
            data={data}
            user={{ userId: project.userId, workingSetSyncEnabled: true }}
            pending={<div data-pending />}
          />
        </QueryClientProvider>,
      );

    await act(async () => render(routeData(1)));
    expect(host.querySelector("[data-readable]")).not.toBeNull();
    expect(mocks.seedProjectRouteData).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWorkingSet).toHaveBeenCalledTimes(1);

    await act(async () => render(routeData(2)));
    expect(mocks.seedProjectRouteData).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWorkingSet).toHaveBeenCalledTimes(1);
  });

  const renderRoute = (id: string, data: ProjectRouteData | null) =>
    root.render(
      <QueryClientProvider client={client}>
        <ProjectRouteBootstrap
          project={{ ...project, id }}
          data={data}
          user={{ userId: project.userId, workingSetSyncEnabled: true }}
          pending={<div data-pending />}
        />
      </QueryClientProvider>,
    );
  const readable = () => host.querySelector("[data-readable]")?.getAttribute("data-readable");

  it("mounts a project being created, then seeds once when its data arrives", async () => {
    await act(async () => renderRoute(project.id, null));
    expect(mocks.seedProjectRouteData).not.toHaveBeenCalled();
    expect(readable()).toBe("unavailable");

    const ready = routeData(1);
    await act(async () => renderRoute(project.id, ready));
    expect(mocks.seedProjectRouteData).toHaveBeenCalledTimes(1);
    expect(mocks.seedProjectRouteData).toHaveBeenLastCalledWith(client, project.id, ready);
    expect(readable()).toBe("absent");

    await act(async () => renderRoute(project.id, routeData(2)));
    expect(mocks.seedProjectRouteData).toHaveBeenCalledTimes(1);
    expect(mocks.hydrateWorkingSet).toHaveBeenCalledTimes(2);
  });

  it("commits the next project when the same instance moves from A to B", async () => {
    const b = "00000000-0000-4000-8000-000000000022";
    const next: ProjectRouteData = { ...routeData(1), workingSet: { status: "unavailable" } };
    await act(async () => renderRoute(project.id, routeData(1)));
    await act(async () => renderRoute(b, next));
    expect(mocks.seedProjectRouteData).toHaveBeenCalledTimes(2);
    expect(mocks.seedProjectRouteData).toHaveBeenLastCalledWith(client, b, next);
    expect(mocks.hydrateWorkingSet).toHaveBeenLastCalledWith(b, next.workingSet, true);
    expect(readable()).toBe("unavailable");
  });
});
