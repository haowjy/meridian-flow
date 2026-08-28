// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, StrictMode, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { EditorWorkScope } from "./editor-work-scope";
import { useContextProjectAuthority } from "./use-context-project-authority";

const mocks = vi.hoisted(() => ({ readTree: vi.fn() }));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  getProjectContextTree: mocks.readTree,
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const restored = {
  kind: "tracked" as const,
  documentId: "restored",
  scheme: "kb" as const,
  path: "/restored.md",
  name: "restored.md",
  editable: true as const,
  filetype: "markdown" as const,
  schemaType: "document" as const,
};
const disabledHydration = { status: "disabled" as const };

beforeEach(() => {
  useContextTabsStore.setState({
    byProject: { project: { tabs: [restored], activeTabId: "restored" } },
    _deskHydrated: true,
  });
});

it("withholds live hosts through one held raw bootstrap and never restores raw authority", async () => {
  const read = deferred<{
    tree: { kind: "dir"; path: string; name: string; children: [] };
    capabilities: null;
  }>();
  mocks.readTree.mockImplementation(() => read.promise);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let setWork: ((work: EditorWorkScope) => void) | null = null;

  function Harness() {
    const [work, updateWork] = useState<EditorWorkScope>({
      status: "ready",
      workId: "work-1",
      source: "route",
    });
    setWork = updateWork;
    const phase = useContextProjectAuthority({
      projectId: "project",
      deskHydrated: true,
      editorScope: work,
      workingSetHydration: disabledHydration,
      queryClient,
    });
    return <div data-phase={phase.status}>{phase.status === "live" ? "host" : "withheld"}</div>;
  }

  await withReactRoot(
    <StrictMode>
      <Harness />
    </StrictMode>,
    async () => {
      expect(document.querySelector("[data-phase]")?.textContent).toBe("withheld");
      expect(mocks.readTree).toHaveBeenCalledOnce();

      await act(async () =>
        read.resolve({
          tree: { kind: "dir", path: "/", name: "Knowledge Base", children: [] },
          capabilities: null,
        }),
      );
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([]);

      useContextTabsStore.setState({
        byProject: { project: { tabs: [restored], activeTabId: "restored" } },
      });
      await act(async () => setWork?.({ status: "loading", workId: "work-1" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("suspended");
      await act(async () => setWork?.({ status: "ready", workId: "work-2", source: "route" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(mocks.readTree).toHaveBeenCalledOnce();
      expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([restored]);
    },
  );
});
