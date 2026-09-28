// @vitest-environment jsdom
/** Project route snapshots commit once per mounted project identity. */
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
  hydrateWorkingSet: vi.fn(() => ({ status: "local" as const, revision: null })),
  readable: vi.fn(() => <div data-readable />),
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

const project: Project = {
  id: "00000000-0000-4000-8000-000000000020",
  userId: "00000000-0000-4000-8000-000000000021",
  slug: "bootstrap",
  isPersonal: false,
  settings: {},
  lastActivityAt: "2026-09-28T00:00:00.000Z",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  deletedAt: null,
  title: "Bootstrap",
  description: null,
};

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
});
