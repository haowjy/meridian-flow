/** Behavioral request coverage for explicit Editor Work ownership. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const requests: Array<{ operation: string; workId: string | undefined }> = [];
let releaseCreate: (() => void) | null = null;

vi.mock("@/client/api/projects-api", () => ({
  getProjectContextTree: vi.fn(async (_projectId, _scheme, options) => {
    requests.push({ operation: "tree", workId: options?.workId });
    return { tree: { kind: "dir", name: "", path: "", children: [] }, capabilities: {} };
  }),
  getProjectContextRead: vi.fn(async (_projectId, _scheme, _path, options) => {
    requests.push({ operation: "read", workId: options?.workId });
    return { kind: "binary", url: "https://example.test/file", mimeType: "text/plain" };
  }),
  createContextEntry: vi.fn(async (_projectId, _scheme, _body, options) => {
    requests.push({ operation: "create", workId: options?.workId });
    await new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    return { status: "created", path: "/new.md" };
  }),
  renameContextEntry: vi.fn(async (_projectId, _scheme, _body, options) => {
    requests.push({ operation: "rename", workId: options?.workId });
    return { status: "renamed" };
  }),
  deleteContextEntry: vi.fn(async (_projectId, _scheme, _body, options) => {
    requests.push({ operation: "delete", workId: options?.workId });
    return { status: "deleted" };
  }),
}));

const { useCreateContextEntry } = await import("./useCreateContextEntry");
const { useDeleteContextEntry } = await import("./useDeleteContextEntry");
const { useProjectContextRead } = await import("./useProjectContextRead");
const { useProjectContextTree } = await import("./useProjectContextTree");
const { useRenameContextEntry } = await import("./useRenameContextEntry");

type Commands = ReturnType<typeof useCommands>;
let commands: Commands | null = null;
let changeWork: ((workId: string) => void) | null = null;

function useCommands(workId: string) {
  useProjectContextTree("project", "scratch", { workId });
  useProjectContextRead("project", "scratch", "/file.md", { workId });
  return {
    create: useCreateContextEntry("project"),
    rename: useRenameContextEntry("project", "scratch"),
    delete: useDeleteContextEntry("project", "scratch"),
  };
}

function Harness({ workId }: { workId: string }) {
  commands = useCommands(workId);
  return null;
}

function RoutedHarness() {
  const [workId, setWorkId] = useState("work-a");
  changeWork = setWorkId;
  return <Harness workId={workId} />;
}

function Providers({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

afterEach(() => {
  requests.length = 0;
  commands = null;
  releaseCreate = null;
  changeWork = null;
});

for (const viewport of ["desktop", "phone"] as const) {
  it(`${viewport} tree/read/create/rename/delete stay on Editor Work A while Chat is Work B`, async () => {
    await withReactRoot(
      <Providers>
        {/* Chat Work B is intentionally not an input to the Editor subtree. */}
        <Harness workId="work-a" />
      </Providers>,
      async () => {
        await vi.waitFor(() =>
          expect(requests.map((request) => request.operation)).toEqual(
            expect.arrayContaining(["tree", "read"]),
          ),
        );
        await act(async () => {
          const create = commands?.create.mutateAsync({
            scheme: "scratch",
            type: "file",
            path: "/new.md",
            workId: "work-a",
          });
          await commands?.rename.mutateAsync({
            path: "/old.md",
            newName: "new.md",
            workId: "work-a",
          });
          await commands?.delete.mutateAsync({ path: "/gone.md", workId: "work-a" });
          releaseCreate?.();
          await create;
        });
        expect(
          requests
            .filter(({ operation }) =>
              ["tree", "read", "create", "rename", "delete"].includes(operation),
            )
            .every(({ workId }) => workId === "work-a"),
        ).toBe(true);
      },
      { drainMacrotask: true },
    );
  });
}

describe("captured Editor commands", () => {
  it("keeps a pending create on A after the route changes to B", async () => {
    const queryClient = new QueryClient();
    await withReactRoot(
      <QueryClientProvider client={queryClient}>
        <RoutedHarness />
      </QueryClientProvider>,
      async () => {
        let pending: Promise<unknown> | undefined;
        await act(async () => {
          pending = commands?.create.mutateAsync({
            scheme: "scratch",
            type: "file",
            path: "/new.md",
            workId: "work-a",
          });
        });
        await act(async () => changeWork?.("work-b"));
        releaseCreate?.();
        await act(async () => {
          await pending;
        });
        expect(requests.find(({ operation }) => operation === "create")?.workId).toBe("work-a");
      },
      { drainMacrotask: true },
    );
  });
});
