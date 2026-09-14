// @vitest-environment jsdom
/** Project-route ownership regressions for cross-door document navigation. */

import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { act, type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type OpenContextRoute,
  ProjectNavigationProvider,
} from "../routing/ProjectNavigationContext";
import {
  type OpenProjectDocument,
  type ProjectDocumentLiveOpener,
  type ProjectDocumentLiveOpenResult,
  ProjectDocumentNavigationAdapter,
  ProjectDocumentNavigationProvider,
  useOpenProjectDocument,
} from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const tabs = vi.hoisted(() => vi.fn());

vi.mock("@/client/stores", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/client/stores")>();
  return {
    ...actual,
    useContextTabsActions: () => ({ openTab: tabs }),
  };
});

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
      <ProjectNavigationProvider openContextRoute={openRoute}>
        <ProjectDocumentNavigationProvider projectId={projectId}>
          {children}
        </ProjectDocumentNavigationProvider>
      </ProjectNavigationProvider>
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
  beforeEach(() => {
    tabs.mockReset().mockImplementation((_projectId, tab) => ({ kind: "opened", tab }));
  });

  it.each([
    "applied",
    "cancelled",
    "superseded",
  ] as const)("publishes through the route owner and reports %s", async (kind) => {
    const decision = deferred<Awaited<ReturnType<OpenContextRoute>>>();
    const openRoute = vi.fn(() => decision.promise);
    const doors: Record<string, OpenProjectDocument> = {};
    await withReactRoot(
      <Owner projectId="project-a" opener={{ open: async () => opened("a") }} openRoute={openRoute}>
        <Door name="catalog" projectId="project-a" doors={doors} />
      </Owner>,
      async () => {
        const opening = doors.catalog({ documentId: "a" });
        await act(async () => undefined);
        expect(tabs).not.toHaveBeenCalled();
        expect(openRoute).toHaveBeenCalledWith(
          expect.objectContaining({ documentId: "a" }),
          expect.objectContaining({ tab: expect.objectContaining({ documentId: "a" }) }),
        );
        decision.resolve({ kind });
        await expect(opening).resolves.toMatchObject({
          kind: kind === "applied" ? "opened" : "cancelled",
        });
      },
    );
  });

  it.each([
    "caller abort",
    "owner disposal",
  ])("does not commit a held route after %s", async (reason) => {
    const permission = deferred<void>();
    const route = vi.fn<OpenContextRoute>(async (_target, options) => {
      await permission.promise;
      return { kind: options?.canCommit?.() ? "applied" : "superseded" };
    });
    const adapter = new ProjectDocumentNavigationAdapter({
      opener: { open: async () => opened("a") },
      openTab: tabs,
      openRoute: route,
    });
    const controller = new AbortController();
    const opening = adapter.open("project-a", { documentId: "a", signal: controller.signal });
    await Promise.resolve();
    expect(route).toHaveBeenCalledOnce();
    if (reason === "caller abort") controller.abort();
    else adapter.dispose();
    permission.resolve();
    await expect(opening).resolves.toEqual({ kind: "cancelled" });
    expect(tabs).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("opens exact local content without waiting for server availability", async () => {
    const session = {} as import("@/core/editor/document-session").DocumentSession;
    const releaseEditor = vi.fn();
    const releasePrepared = vi.fn();
    const record = {
      resource: {
        handle: "resource-a",
        revision: 1,
        identity: { documentId: "local-a", revision: 1 },
        content: { kind: "exact", databaseName: "exact", schema: null },
        canonical: null,
        lifecycle: { kind: "local" },
        aliases: {},
        obligations: { createEligibility: { eligibleAt: 1 } },
      },
      intents: [
        {
          projectId: "project-a",
          handle: "resource-a",
          intentId: "create",
          sequence: 1,
          identityRevision: 1,
          desired: { kind: "create", folderPath: "", provisionalName: "Untitled" },
          attempts: [],
          state: "pending",
        },
      ],
    } as const;
    const openKnownDocument = vi.fn(async () => ({
      kind: "opened" as const,
      key: { handle: "resource-a" },
      record,
      handle: {
        key: { handle: "resource-a" },
        documentId: "local-a",
        session,
        release: releasePrepared,
      },
    }));
    const openDocument = vi.fn(async () => ({
      kind: "opened" as const,
      handle: {
        key: { handle: "resource-a" },
        documentId: "local-a",
        session,
        release: releaseEditor,
      },
    }));
    const opener = { open: vi.fn() };
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
    const adapter = new ProjectDocumentNavigationAdapter({
      opener,
      openTab: tabs,
      openRoute,
      resources: { accountId: "account", openKnownDocument, openDocument } as never,
    });

    const result = await adapter.open("project-a", { documentId: "local-a" });

    expect(result).toMatchObject({
      kind: "opened",
      document: { entryId: "local-a", scope: { kind: "project", projectId: "project-a" } },
    });
    expect(opener.open).not.toHaveBeenCalled();
    expect(openRoute).toHaveBeenCalledWith(
      { scheme: "unfiled", path: "/Untitled", workId: null, documentId: "local-a" },
      expect.any(Object),
    );
    if (result.kind !== "opened") throw new Error("Expected local document");
    const binding = await result.admission.bind("editor-owner");
    expect(binding.session).toBe(session);
    expect(binding.local).toBe(true);
    expect(releasePrepared).toHaveBeenCalledOnce();
    expect(openDocument).toHaveBeenLastCalledWith(
      "project-a",
      { handle: "resource-a" },
      "editor-owner",
    );
    binding.release();
    expect(releaseEditor).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("falls through to server admission for metadata-only catalog resources", async () => {
    const serverResult = opened("server-a");
    const opener = { open: vi.fn(async () => serverResult) };
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
    const adapter = new ProjectDocumentNavigationAdapter({
      opener,
      openTab: tabs,
      openRoute,
      resources: {
        accountId: "account",
        openKnownDocument: vi.fn(async () => ({
          kind: "unavailable" as const,
          reason: "unacquired" as const,
          key: { handle: "catalog:server-a" },
          record: {
            resource: {
              handle: "catalog:server-a",
              revision: 1,
              identity: { documentId: "server-a", revision: 1 },
              content: { kind: "unacquired" },
              canonical: {
                scheme: "manuscript",
                path: "/server-a.md",
                name: "server-a.md",
                workId: null,
              },
              lifecycle: { kind: "acknowledged", availabilityGeneration: null },
              aliases: {},
              obligations: {},
            },
            intents: [],
          },
        })),
        openDocument: vi.fn(),
      } as never,
    });

    await expect(adapter.open("project-a", { documentId: "server-a" })).resolves.toBe(serverResult);
    expect(opener.open).toHaveBeenCalledWith(
      expect.objectContaining({ source: "server", documentId: "server-a" }),
    );
    expect(openRoute).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("falls through to server admission when an acknowledged exact cache is unusable", async () => {
    const serverResult = opened("server-a");
    const opener = { open: vi.fn(async () => serverResult) };
    const record = {
      resource: {
        handle: "resource-a",
        revision: 1,
        identity: { documentId: "server-a", revision: 1 },
        content: { kind: "exact" as const, databaseName: "stale", schema: "old-schema" },
        canonical: {
          scheme: "manuscript" as const,
          path: "/server-a.md",
          name: "server-a.md",
          workId: null,
        },
        lifecycle: { kind: "acknowledged" as const, availabilityGeneration: "1" },
        aliases: {},
        obligations: {},
      },
      intents: [],
    };
    const adapter = new ProjectDocumentNavigationAdapter({
      opener,
      openTab: tabs,
      openRoute: vi.fn(async () => ({ kind: "applied" as const })),
      resources: {
        accountId: "account",
        openKnownDocument: vi.fn(async () => ({
          kind: "unavailable" as const,
          reason: "schema-mismatch" as const,
          key: { handle: "resource-a" },
          record,
        })),
        openDocument: vi.fn(),
      } as never,
    });

    await expect(adapter.open("project-a", { documentId: "server-a" })).resolves.toBe(serverResult);
    expect(opener.open).toHaveBeenCalledOnce();
    adapter.dispose();
  });

  it("does not fall through to server authority for a locally pending delete", async () => {
    const opener = { open: vi.fn() };
    const adapter = new ProjectDocumentNavigationAdapter({
      opener,
      openTab: tabs,
      openRoute: vi.fn(async () => ({ kind: "applied" as const })),
      resources: {
        accountId: "account",
        openKnownDocument: vi.fn(async () => ({
          kind: "unavailable" as const,
          reason: "deleted" as const,
          key: { handle: "resource-a" },
          record: {
            resource: {
              handle: "resource-a",
              revision: 2,
              identity: { documentId: "local-a", revision: 1 },
              content: { kind: "exact", databaseName: "exact", schema: null },
              canonical: {
                scheme: "manuscript",
                path: "/Chapter.md",
                name: "Chapter.md",
                workId: null,
              },
              lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
              aliases: {},
              obligations: {},
            },
            intents: [
              {
                projectId: "project-a",
                handle: "resource-a",
                intentId: "delete",
                sequence: 1,
                identityRevision: 1,
                desired: { kind: "delete" },
                attempts: [],
                state: "pending",
              },
            ],
          },
        })),
        openDocument: vi.fn(),
      } as never,
    });

    await expect(adapter.open("project-a", { documentId: "local-a" })).resolves.toEqual({
      kind: "unavailable",
      reason: "deleted",
    });
    expect(opener.open).not.toHaveBeenCalled();
    adapter.dispose();
  });

  it("opens in the background without cancelling a pending foreground destination", async () => {
    const delayed = deferred<ProjectDocumentLiveOpenResult>();
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
    const doors: Record<string, OpenProjectDocument> = {};
    await withReactRoot(
      <Owner
        projectId="project-a"
        opener={{
          open: async ({ documentId }) =>
            documentId === "a" ? delayed.promise : opened(documentId),
        }}
        openRoute={openRoute}
      >
        <Door name="catalog" projectId="project-a" doors={doors} />
      </Owner>,
      async () => {
        const foreground = doors.catalog({ documentId: "a" });
        await expect(
          doors.catalog({ documentId: "b", disposition: "background" }),
        ).resolves.toMatchObject({ kind: "opened" });
        expect(openRoute).not.toHaveBeenCalled();
        delayed.resolve(opened("a"));
        await expect(foreground).resolves.toMatchObject({ kind: "opened" });
        expect(openRoute).toHaveBeenCalledOnce();
        expect(tabs).toHaveBeenCalledOnce();
      },
    );
  });

  it("shares the latest attempt across distinct doors and preserves dispositions", async () => {
    const delayedA = deferred<ProjectDocumentLiveOpenResult>();
    const open = vi.fn(({ documentId }: { documentId: string }) =>
      documentId === "a" ? delayedA.promise : Promise.resolve(opened(documentId)),
    );
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
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

        expect(tabs).not.toHaveBeenCalled();
        expect(openRoute).toHaveBeenCalledOnce();
        expect(openRoute).toHaveBeenCalledWith(
          {
            scheme: "manuscript",
            path: "/b.md",
            workId: null,
            documentId: "b",
          },
          expect.objectContaining({ tab: expect.objectContaining({ documentId: "b" }) }),
        );

        await expect(
          doors.catalog({ documentId: "background", disposition: "background" }),
        ).resolves.toMatchObject({ kind: "opened" });
        expect(tabs).toHaveBeenCalledOnce();
        expect(openRoute).toHaveBeenCalledOnce();
      },
    );
  });

  it.each([
    null,
    "work-b",
  ])("routes a chat resource to its explanatory destination without a tab %s", async (workId) => {
    const document: CatalogFileEntry = {
      kind: "file",
      entryId: "image",
      sourceId: "source",
      parentId: "source",
      scope: workId
        ? { kind: "work", projectId: "project-a", workId }
        : { kind: "none", projectId: "project-a" },
      name: "Map.png",
      path: ["Map.png"],
      aliases: [],
      uri: workId ? "uploads://@work-b/Map.png" : "uploads://@/Map.png",
      provisionalName: false,
      editable: false,
      disposition: "binary",
      fileType: "image",
      mimeType: "image/png",
    };
    const open = vi.fn(
      async (): Promise<ProjectDocumentLiveOpenResult> => ({ kind: "not-editable", document }),
    );
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
    const doors: Record<string, OpenProjectDocument> = {};
    await withReactRoot(
      <Owner projectId="project-a" opener={{ open }} openRoute={openRoute}>
        <Door name="reference" projectId="project-a" doors={doors} />
      </Owner>,
      async () => {
        await doors.reference({ documentId: "image", workId: "work-a" });
        expect(tabs).not.toHaveBeenCalled();
        expect(openRoute).toHaveBeenCalledWith(
          { scheme: "uploads", path: "/Map.png", workId, documentId: "image" },
          expect.objectContaining({ tab: undefined }),
        );
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
    const openRoute = vi.fn(async () => ({ kind: "applied" as const }));
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
        <Owner
          projectId="project-a"
          opener={{ open }}
          openRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        >
          <Door name="a" projectId="project-a" doors={doors} />
        </Owner>
        <Owner
          projectId="project-b"
          opener={{ open }}
          openRoute={vi.fn(async () => ({ kind: "applied" as const }))}
        >
          <Door name="b" projectId="project-b" doors={doors} />
        </Owner>
      </>,
      async () => {
        const first = doors.a({ documentId: "a" });
        await expect(doors.b({ documentId: "b" })).resolves.toMatchObject({ kind: "opened" });
        delayedA.resolve(opened("a"));
        await expect(first).resolves.toMatchObject({ kind: "opened" });
        expect(tabs).not.toHaveBeenCalled();
      },
    );
  });
});
