// @vitest-environment jsdom
/** Concrete-host adoption, usability, and cleanup contracts. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { AdmittedLiveDocument, LiveDocumentBinding } from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";
import { type LiveDocumentHostBinding, useLiveDocumentBinding } from "./use-live-document-binding";

function session(
  snapshot: { status: string; schemaFence: object | null } = {
    status: "synced",
    schemaFence: null,
  },
  waitForCurrentSync: () => Promise<void> = async () => undefined,
): DocumentSession {
  return { waitForCurrentSync, getSnapshot: () => snapshot } as unknown as DocumentSession;
}

function admission(
  generation: string,
  boundSession: DocumentSession,
  owners: string[],
  releases: Array<ReturnType<typeof vi.fn>>,
  identity: { projectId?: string; documentId?: string; generation?: string } = {},
): AdmittedLiveDocument {
  return {
    projectId: "project-a",
    documentId: "document-a",
    generation,
    bind: async (ownerId): Promise<LiveDocumentBinding> => {
      owners.push(ownerId);
      const release = vi.fn();
      releases.push(release);
      return {
        projectId: identity.projectId ?? "project-a",
        documentId: identity.documentId ?? "document-a",
        generation: identity.generation ?? generation,
        session: boundSession,
        release,
      };
    },
  };
}

function Host({ expose }: { expose(binding: LiveDocumentHostBinding): void }) {
  const binding = useLiveDocumentBinding({
    projectId: "project-a",
    documentId: "document-a",
    owner: "desktop-server-tab",
  });
  useEffect(() => expose(binding), [binding, expose]);
  return null;
}

describe("useLiveDocumentBinding", () => {
  it("atomically adopts the exact synced same session under a unique owner", async () => {
    const sharedSession = session();
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const ordinary = admission("1", sharedSession, owners, releases);
    const candidate = admission("2", sharedSession, owners, releases);
    const opener = {
      open: vi.fn(async () => ({ kind: "opened", document: {}, admission: ordinary }) as never),
    };
    let host!: LiveDocumentHostBinding;

    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host
          expose={(value) => {
            host = value;
          }}
        />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        expect(host.state.kind).toBe("opened");
        let result: unknown;
        await act(async () => {
          result = await host.adoptAndAcknowledge(candidate, {
            signal: new AbortController().signal,
            timeoutMs: 50,
          });
        });
        expect(result).toEqual({
          kind: "acknowledged",
          projectId: "project-a",
          documentId: "document-a",
          generation: "2",
        });
        expect(new Set(owners).size).toBe(2);
        expect(owners[0]).not.toBe(owners[1]);
        expect(releases[0]).toHaveBeenCalledOnce();
        expect(releases[1]).not.toHaveBeenCalled();
      },
    );
    expect(releases[1]).toHaveBeenCalledOnce();
  });

  it("recovers a previously failed host by consuming the Apply admission", async () => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const opener = { open: vi.fn(async () => ({ kind: "unavailable" }) as never) };
    let host!: LiveDocumentHostBinding;
    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host
          expose={(value) => {
            host = value;
          }}
        />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        expect(host.state.kind).toBe("failed");
        let result: unknown;
        await act(async () => {
          result = await host.adoptAndAcknowledge(admission("2", session(), owners, releases), {
            signal: new AbortController().signal,
          });
        });
        expect(result).toMatchObject({ kind: "acknowledged", generation: "2" });
        expect(host.state.kind).toBe("opened");
      },
    );
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it.each([
    ["schema fenced", session({ status: "synced", schemaFence: { reason: "stale" } })],
    ["not synced", session({ status: "offline", schemaFence: null })],
  ])("rejects and releases a %s candidate without replacing the old binding", async (_name, bad) => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const ordinarySession = session();
    const opener = {
      open: vi.fn(
        async () =>
          ({
            kind: "opened",
            document: {},
            admission: admission("1", ordinarySession, owners, releases),
          }) as never,
      ),
    };
    let host!: LiveDocumentHostBinding;
    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host
          expose={(value) => {
            host = value;
          }}
        />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        await expect(
          host.adoptAndAcknowledge(admission("2", bad, owners, releases), {
            signal: new AbortController().signal,
          }),
        ).resolves.toEqual({ kind: "unusable" });
        expect(host.state).toMatchObject({ kind: "opened", session: ordinarySession });
        expect(releases[0]).not.toHaveBeenCalled();
        expect(releases[1]).toHaveBeenCalledOnce();
      },
    );
  });

  it("aborts a pending sync on unmount and releases the candidate exactly once", async () => {
    let finishSync!: () => void;
    const pendingSync = new Promise<void>((resolve) => (finishSync = resolve));
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const opener = { open: vi.fn(async () => ({ kind: "unavailable" }) as never) };
    let host!: LiveDocumentHostBinding;
    let result!: Promise<unknown>;
    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host
          expose={(value) => {
            host = value;
          }}
        />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        result = host.adoptAndAcknowledge(
          admission(
            "2",
            session(undefined, () => pendingSync),
            owners,
            releases,
          ),
          { signal: new AbortController().signal },
        );
        await act(async () => undefined);
      },
    );
    await expect(result).resolves.toEqual({ kind: "cancelled" });
    expect(releases[0]).toHaveBeenCalledOnce();
    finishSync();
    await Promise.resolve();
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it("rejects a binding whose concrete identity differs from its admission", async () => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const opener = { open: vi.fn(async () => ({ kind: "unavailable" }) as never) };
    let host!: LiveDocumentHostBinding;
    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host
          expose={(value) => {
            host = value;
          }}
        />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        await expect(
          host.adoptAndAcknowledge(
            admission("2", session(), owners, releases, { generation: "wrong" }),
            { signal: new AbortController().signal },
          ),
        ).resolves.toEqual({ kind: "unusable" });
        expect(releases[0]).toHaveBeenCalledOnce();
      },
    );
  });
});
