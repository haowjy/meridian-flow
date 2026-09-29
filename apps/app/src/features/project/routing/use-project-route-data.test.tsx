// @vitest-environment jsdom
/** Route data seeds on mount, once more when a project being created gets its data, and afresh per project. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type ProjectRouteData, seedProjectRouteData } from "@/client/query/project-route-data";
import { hydrateWorkingSet } from "@/client/working-set";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { useProjectRouteData } from "./use-project-route-data";

vi.mock("@/client/query/project-route-data", () => ({ seedProjectRouteData: vi.fn() }));
vi.mock("@/client/working-set", () => ({
  hydrateWorkingSet: vi.fn((_: string, result: { status: string }) => ({ status: result.status })),
}));

const data = (): ProjectRouteData => ({
  threads: [],
  works: null,
  worksStarted: 0,
  workingSet: { status: "absent" },
});

let plan: unknown;
let setData!: (value: ProjectRouteData | null) => void;
let setProjectId!: (value: string) => void;
function Host({ initial = null }: { initial?: ProjectRouteData | null }) {
  const [value, set] = useState<ProjectRouteData | null>(initial);
  const [projectId, setProject] = useState("project-1");
  setData = set;
  setProjectId = setProject;
  plan = useProjectRouteData(projectId, value, true);
  return null;
}

beforeEach(() => vi.clearAllMocks());

it("seeds when a created project's data arrives, and not again for a later load", async () => {
  const client = new QueryClient();
  const ready = data();
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
    async () => {
      expect(seedProjectRouteData).not.toHaveBeenCalled();
      expect(plan).toEqual({ status: "unavailable" });

      await act(async () => setData(ready));
      expect(seedProjectRouteData).toHaveBeenCalledTimes(1);
      expect(seedProjectRouteData).toHaveBeenLastCalledWith(client, "project-1", ready);
      expect(plan).toEqual({ status: "absent" });

      await act(async () => setData(data()));
      expect(seedProjectRouteData).toHaveBeenCalledTimes(1);
      expect(hydrateWorkingSet).toHaveBeenCalledTimes(2);
    },
  );
});

it("seeds the next project when the same route instance moves from A to B", async () => {
  const client = new QueryClient();
  const a = data();
  const b: ProjectRouteData = { ...data(), workingSet: { status: "unavailable" } };
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Host initial={a} />
    </QueryClientProvider>,
    async () => {
      expect(seedProjectRouteData).toHaveBeenLastCalledWith(client, "project-1", a);
      expect(plan).toEqual({ status: "absent" });

      await act(async () => {
        setProjectId("project-2");
        setData(b);
      });
      expect(seedProjectRouteData).toHaveBeenCalledTimes(2);
      expect(seedProjectRouteData).toHaveBeenLastCalledWith(client, "project-2", b);
      expect(hydrateWorkingSet).toHaveBeenLastCalledWith("project-2", b.workingSet, true);
      expect(plan).toEqual({ status: "unavailable" });
    },
  );
});
