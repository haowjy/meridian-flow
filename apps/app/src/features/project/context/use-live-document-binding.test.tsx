// @vitest-environment jsdom
/** The ordinary live-document host binding: open, retry after failure, release on teardown. */
import { act, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { AdmittedLiveDocument } from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";
import { type LiveDocumentHostBinding, useLiveDocumentBinding } from "./use-live-document-binding";

const docSession = {} as DocumentSession;

function admission(owners: string[], releases: Array<ReturnType<typeof vi.fn>>) {
  return {
    projectId: "project-a",
    documentId: "document-a",
    generation: "2",
    bind: async (ownerId: string) => {
      owners.push(ownerId);
      const release = vi.fn();
      releases.push(release);
      return {
        projectId: "project-a",
        documentId: "document-a",
        generation: "2",
        session: docSession,
        release,
      };
    },
  } as AdmittedLiveDocument;
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
  it("opens the document and releases its binding exactly once on unmount", async () => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const opener = {
      open: vi.fn(async () => ({ kind: "opened", admission: admission(owners, releases) })),
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
        expect(host.state).toMatchObject({ kind: "opened", session: docSession, generation: "2" });
        expect(releases[0]).not.toHaveBeenCalled();
      },
    );
    expect(releases[0]).toHaveBeenCalledOnce();
  });

  it("shows a failed open and retries it with a fresh binding owner", async () => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const opener = {
      open: vi
        .fn()
        .mockResolvedValueOnce({ kind: "unavailable" })
        .mockResolvedValue({ kind: "opened", admission: admission(owners, releases) }),
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
        expect(host.state).toEqual({ kind: "failed", documentId: "document-a" });

        await act(async () => host.retry());
        await act(async () => undefined);
        expect(host.state.kind).toBe("opened");
        expect(opener.open).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("releases a binding that finishes after the host is gone", async () => {
    const owners: string[] = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    let finishBind!: () => void;
    const late = admission(owners, releases);
    const bind = late.bind;
    late.bind = async (ownerId) => {
      await new Promise<void>((resolve) => (finishBind = resolve));
      return bind(ownerId);
    };
    const opener = { open: vi.fn(async () => ({ kind: "opened", admission: late })) };

    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <Host expose={() => undefined} />
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
      },
    );
    finishBind();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases[0]).toHaveBeenCalledOnce();
  });
});
