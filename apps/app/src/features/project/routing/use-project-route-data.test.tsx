// @vitest-environment jsdom
/** Route data seeds on mount, and once more when a project being created gets its data. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
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
function Host() {
  const [value, set] = useState<ProjectRouteData | null>(null);
  setData = set;
  plan = useProjectRouteData("project-1", value, true);
  return null;
}

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
