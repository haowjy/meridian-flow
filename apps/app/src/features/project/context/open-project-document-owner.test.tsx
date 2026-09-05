// @vitest-environment jsdom
/** Project-route ownership regressions for cross-door document navigation. */

import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { act, type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type OpenContextRoute, ProjectContextRouteProvider } from "../routing/ProjectContextRoute";
import {
  type OpenProjectDocument,
  type ProjectDocumentLiveOpener,
  type ProjectDocumentLiveOpenResult,
  ProjectDocumentNavigationProvider,
  useOpenProjectDocument,
} from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const tabs = vi.hoisted(() => vi.fn());

vi.mock("@/client/stores", () => ({
  useContextTabsActions: () => ({ openTab: tabs }),
}));

const admission = { bind: vi.fn() } as never;

function opened(documentId: string): ProjectDocumentLiveOpenResult {
  return {
    kind: "opened",
    document: {
      entryId: documentId,
      scope: { kind: "project", projectId: "project-a" },
      sourceId: "source-a",
      parentId: "source-a",
      aliases: [],
      name: `${documentId}.md`,
      path: [`${documentId}.md`],
      uri: `manuscript://project-a/${documentId}.md`,
      provisionalName: false,
      kind: "file",
      scheme: "manuscript",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    } as unknown as CatalogFileEntry,
    admission,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Owner({
  projectId,
  opener,
  openRoute,
  children,
}: {
  projectId: string;
  opener: Pick<ProjectDocumentLiveOpener, "open">;
  openRoute: OpenContextRoute;
  children: ReactNode;
}) {
  return (
    <ProjectDocumentLiveOpenerContext.Provider value={opener as ProjectDocumentLiveOpener}>
      <ProjectContextRouteProvider openContextRoute={openRoute}>
        <ProjectDocumentNavigationProvider projectId={projectId}>
          {children}
        </ProjectDocumentNavigationProvider>
      </ProjectContextRouteProvider>
    </ProjectDocumentLiveOpenerContext.Provider>
  );
}

function Door({
  name,
  projectId,
  doors,
}: {
  name: string;
  projectId: string;
  doors: Record<string, OpenProjectDocument>;
}) {
  doors[name] = useOpenProjectDocument(projectId);
  return null;
}

describe("ProjectDocumentNavigationProvider", () => {
  beforeEach(() => tabs.mockReset());

  it("shares the latest attempt across distinct doors and preserves dispositions", async () => {
    const delayedA = deferred<ProjectDocumentLiveOpenResult>();
    const open = vi.fn(({ documentId }: { documentId: string }) =>
      documentId === "a" ? delayedA.promise : Promise.resolve(opened(documentId)),
    );
    const openRoute = vi.fn(async () => undefined);
    const doors: Record<string, OpenProjectDocument> = {};

    await withReactRoot(
      <Owner projectId="project-a" opener={{ open }} openRoute={openRoute}>
        <Door name="catalog" projectId="project-a" doors={doors} />
        <Door name="link" projectId="project-a" doors={doors} />
      </Owner>,
      async () => {
        const stale = doors.catalog({ documentId: "a" });
        await expect(doors.link({ documentId: "b" })).resolves.toMatchObject({ kind: "opened" });
        delayedA.resolve(opened("a"));
        await expect(stale).resolves.toEqual({ kind: "cancelled" });

        expect(tabs).toHaveBeenCalledTimes(1);
        expect(tabs.mock.calls[0]?.[1]).toMatchObject({ documentId: "b" });
        expect(openRoute).toHaveBeenCalledOnce();
        expect(openRoute).toHaveBeenCalledWith({
          scheme: "manuscript",
          path: "/b.md",
          workId: null,
        });

        await expect(
          doors.catalog({ documentId: "background", disposition: "background" }),
        ).resolves.toMatchObject({ kind: "opened" });
        expect(tabs).toHaveBeenCalledTimes(2);
        expect(openRoute).toHaveBeenCalledOnce();
      },
    );
  });

  it.each(["project change", "provider unmount"])("cancels on %s", async (exit) => {
    const delayed = deferred<ProjectDocumentLiveOpenResult>();
    let signal: AbortSignal | undefined;
    const open = vi.fn((request: { signal?: AbortSignal }) => {
      signal = request.signal;
      return delayed.promise;
    });
    const doors: Record<string, OpenProjectDocument> = {};
    const openRoute = vi.fn(async () => undefined);
    let leave!: () => void;

    function Harness() {
      const [projectId, setProjectId] = useState<string | null>("project-a");
      leave = () => setProjectId(exit === "project change" ? "project-b" : null);
      return projectId ? (
        <Owner projectId={projectId} opener={{ open }} openRoute={openRoute}>
          <Door name="door" projectId={projectId} doors={doors} />
        </Owner>
      ) : null;
    }

    await withReactRoot(<Harness />, async () => {
      const pending = doors.door({ documentId: "a" });
      await act(async () => leave());
      expect(signal?.aborted).toBe(true);
      delayed.resolve(opened("a"));
      await expect(pending).resolves.toEqual({ kind: "cancelled" });
    });
  });

  it("keeps independent project-route owners isolated", async () => {
    const delayedA = deferred<ProjectDocumentLiveOpenResult>();
    const open = vi.fn(({ documentId }: { documentId: string }) =>
      documentId === "a" ? delayedA.promise : Promise.resolve(opened(documentId)),
    );
    const doors: Record<string, OpenProjectDocument> = {};

    await withReactRoot(
      <>
        <Owner projectId="project-a" opener={{ open }} openRoute={vi.fn(async () => undefined)}>
          <Door name="a" projectId="project-a" doors={doors} />
        </Owner>
        <Owner projectId="project-b" opener={{ open }} openRoute={vi.fn(async () => undefined)}>
          <Door name="b" projectId="project-b" doors={doors} />
        </Owner>
      </>,
      async () => {
        const first = doors.a({ documentId: "a" });
        await expect(doors.b({ documentId: "b" })).resolves.toMatchObject({ kind: "opened" });
        delayedA.resolve(opened("a"));
        await expect(first).resolves.toMatchObject({ kind: "opened" });
        expect(tabs).toHaveBeenCalledTimes(2);
      },
    );
  });
});
