import type { ProjectContextTreeFile } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  type ContextDeskReconciliationScope,
  validateContextDeskTabs,
} from "./working-set-tab-seeding";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => (resolve = settle)), resolve };
}

function tab(workId: string, name = workId) {
  return {
    kind: "tracked" as const,
    documentId: `document-${workId}`,
    scheme: "scratch" as const,
    path: "/same.md",
    name: `${name}.md`,
    workId,
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
}

function response(workId: string, name: string) {
  const file = {
    kind: "file",
    documentId: `document-${workId}`,
    path: "/same.md",
    name: `${name}.md`,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  } as ProjectContextTreeFile;
  return { tree: file };
}

describe("Editor Work desk validation", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _deskHydrated: true });
  });

  it("lets only the live A to B to A generation commit", async () => {
    const reads = [deferred<ReturnType<typeof response>>(), deferred(), deferred()];
    let read = 0;
    const queryClient = {
      fetchQuery: () => reads[read++]?.promise,
    } as unknown as QueryClient;
    let live: ContextDeskReconciliationScope | null = null;
    const isLiveScope = (scope: ContextDeskReconciliationScope) =>
      live?.projectId === scope.projectId &&
      live.editorWorkId === scope.editorWorkId &&
      live.generation === scope.generation;
    const launch = (scope: ContextDeskReconciliationScope) => {
      live = scope;
      useContextTabsStore.getState().replaceTabs("project-1", [tab(scope.editorWorkId ?? "none")]);
      return validateContextDeskTabs({ queryClient, scope, isLiveScope });
    };

    const firstA = launch({ projectId: "project-1", editorWorkId: "work-a", generation: 1 });
    const workB = launch({ projectId: "project-1", editorWorkId: "work-b", generation: 2 });
    const secondA = launch({ projectId: "project-1", editorWorkId: "work-a", generation: 3 });

    reads[2].resolve(response("work-a", "current-a"));
    await secondA;
    reads[1].resolve(response("work-b", "late-b"));
    await workB;
    reads[0].resolve(response("work-a", "old-a"));
    await firstA;

    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([
      tab("work-a", "current-a"),
    ]);
  });
});
