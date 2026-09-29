// @vitest-environment jsdom
/**
 * The project rename shows at once, and an older rename's refusal neither rolls
 * back over a newer title nor asks its field to reopen.
 */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { projectQueryKeys } from "./project-query-keys";
import { useRenameProject } from "./useRenameProject";

const mocks = vi.hoisted(() => ({ updateProject: vi.fn() }));
vi.mock("@/client/api/projects-api", () => ({ updateProject: mocks.updateProject }));

const PROJECT = { id: "project-1", title: "Old" } as Project;

function deferred() {
  let resolve!: (project: Project) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Project>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let rename!: (title: string) => Promise<void>;
function Probe() {
  rename = useRenameProject(PROJECT);
  return null;
}

function setup() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(projectQueryKeys.list, [PROJECT]);
  client.setQueryData(projectQueryKeys.detail(PROJECT.id), PROJECT);
  const title = () => ({
    list: client.getQueryData<Project[]>(projectQueryKeys.list)?.[0]?.title,
    detail: client.getQueryData<Project>(projectQueryKeys.detail(PROJECT.id))?.title,
  });
  const requests = [deferred(), deferred()];
  mocks.updateProject.mockReturnValueOnce(requests[0].promise);
  mocks.updateProject.mockReturnValueOnce(requests[1].promise);
  return { client, title, a: requests[0], b: requests[1] };
}

const render = (client: QueryClient, run: () => Promise<void>) =>
  withReactRoot(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
    run,
    { drainMacrotask: true },
  );

afterEach(() => mocks.updateProject.mockReset());

it("keeps a pending newer title when an older rename is refused, without rejecting", async () => {
  const { client, title, a, b } = setup();
  await render(client, async () => {
    let renamedA!: Promise<void>;
    await act(async () => {
      renamedA = rename("A");
      void rename("B").catch(() => {});
    });
    expect(title()).toEqual({ list: "B", detail: "B" });

    await act(async () => a.reject(new Error("refused")));
    await expect(renamedA).resolves.toBeUndefined();
    expect(title()).toEqual({ list: "B", detail: "B" });

    await act(async () => b.resolve({ ...PROJECT, title: "B" }));
    expect(title()).toEqual({ list: "B", detail: "B" });
  });
});

it("keeps a confirmed newer title when an older rename is refused afterwards", async () => {
  const { client, title, a, b } = setup();
  await render(client, async () => {
    await act(async () => {
      void rename("A");
      void rename("B");
    });
    await act(async () => b.resolve({ ...PROJECT, title: "B" }));
    await act(async () => a.reject(new Error("refused")));
    expect(title()).toEqual({ list: "B", detail: "B" });
  });
});

it("reverts the latest refused rename to the last confirmed title, and rejects", async () => {
  const { client, title, a, b } = setup();
  await render(client, async () => {
    let renamedB!: Promise<void>;
    await act(async () => {
      void rename("A");
      renamedB = rename("B");
      renamedB.catch(() => {});
    });
    await act(async () => a.resolve({ ...PROJECT, title: "A" }));
    expect(title()).toEqual({ list: "B", detail: "B" });

    await act(async () => b.reject(new Error("refused")));
    await expect(renamedB).rejects.toThrow("refused");
    expect(title()).toEqual({ list: "A", detail: "A" });
  });
});
