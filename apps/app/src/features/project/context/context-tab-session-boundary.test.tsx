// @vitest-environment jsdom
/** Open-tab binding lifetime is independent from warm editor view lifetime. */
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextTabSessionBoundary } from "./ContextEditorMountHost";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

vi.mock("@/features/editor/EditorView", () => ({ EditorView: () => null }));
const resources = vi.hoisted(() => ({
  keyForDocument: vi.fn<
    (projectId: string, documentId: string) => Promise<{ handle: string } | null>
  >(async () => null),
  openDocument: vi.fn(),
  canAcquireRemoteDocument: vi.fn(async () => true),
  captureServerSession: vi.fn(async () => undefined),
}));
vi.mock("./account-feature-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-feature-context")>();
  return {
    ...actual,
    useAccountResourceReplica: () => resources,
  };
});

describe("ContextTabSessionBoundary", () => {
  beforeEach(() => {
    resources.keyForDocument.mockReset().mockResolvedValue(null);
    resources.openDocument.mockReset();
    resources.canAcquireRemoteDocument.mockReset().mockResolvedValue(true);
    resources.captureServerSession.mockReset().mockResolvedValue(undefined);
  });

  it("survives warm-view eviction and releases only when the actual tab closes", async () => {
    const session = {} as DocumentSession;
    const release = vi.fn();
    const bind = vi.fn(async () => ({
      projectId: "project-a",
      documentId: "document-a",
      generation: "1",
      session,
      release,
    }));
    const opener = {
      open: vi.fn(async () => ({
        kind: "opened" as const,
        document: {} as never,
        admission: {
          projectId: "project-a",
          documentId: "document-a",
          generation: "1",
          bind,
        },
      })),
    };
    let setWarm!: (warm: boolean) => void;
    let setOpen!: (open: boolean) => void;
    const seen: Array<DocumentSession | null> = [];

    function Harness() {
      const [warm, updateWarm] = useState(true);
      const [open, updateOpen] = useState(true);
      setWarm = updateWarm;
      setOpen = updateOpen;
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          {open ? (
            <ContextTabSessionBoundary projectId="project-a" documentId="document-a" active={warm}>
              {(bound) => {
                if (warm) seen.push(bound);
                return null;
              }}
            </ContextTabSessionBoundary>
          ) : null}
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      expect(seen).toContain(session);
      expect(bind).toHaveBeenCalledOnce();

      await act(async () => setWarm(false));
      expect(release).not.toHaveBeenCalled();
      await act(async () => setWarm(true));
      expect(bind).toHaveBeenCalledOnce();
      expect(seen.at(-1)).toBe(session);

      await act(async () => setOpen(false));
      expect(release).toHaveBeenCalledOnce();
    });
  });

  it("never presents a cached session after the tab changes resource identity", async () => {
    const sessionA = {} as DocumentSession;
    const sessionB = {} as DocumentSession;
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    resources.keyForDocument.mockImplementation(async (_projectId, documentId) =>
      documentId === "document-a" ? { handle: "resource-a" } : null,
    );
    resources.openDocument.mockResolvedValue({
      kind: "opened",
      handle: { documentId: "document-a", session: sessionA, release: releaseA },
    });
    const opener = {
      open: vi.fn(async ({ documentId }: { documentId: string }) => ({
        kind: "opened" as const,
        document: {} as never,
        admission: {
          projectId: "project-a",
          documentId,
          generation: "2",
          bind: async () => ({
            projectId: "project-a",
            documentId,
            generation: "2",
            session: sessionB,
            release: releaseB,
          }),
        },
      })),
    };
    let show!: (documentId: string) => void;
    const seen: Array<{
      documentId: string;
      session: DocumentSession | null;
      localContentReady: boolean;
    }> = [];
    function Harness() {
      const [documentId, setDocumentId] = useState("document-a");
      show = setDocumentId;
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextTabSessionBoundary projectId="project-a" documentId={documentId}>
            {(session, _failed, localContentReady) => {
              seen.push({ documentId, session, localContentReady });
              return null;
            }}
          </ContextTabSessionBoundary>
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.session).toBe(sessionA));
      expect(seen.at(-1)?.localContentReady).toBe(true);

      await act(async () => show("document-b"));
      await vi.waitFor(() => expect(seen.at(-1)?.session).toBe(sessionB));

      expect(
        seen.some(({ documentId, session }) => documentId === "document-b" && session === sessionA),
      ).toBe(false);
      expect(releaseA).toHaveBeenCalledOnce();
    });
  });

  it("never presents a server session after the tab changes document identity", async () => {
    const sessionA = {} as DocumentSession;
    const sessionB = {} as DocumentSession;
    let releaseB!: () => void;
    const waitForB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const opener = {
      open: vi.fn(async ({ documentId }: { documentId: string }) => {
        if (documentId === "document-b") await waitForB;
        const session = documentId === "document-a" ? sessionA : sessionB;
        return {
          kind: "opened" as const,
          document: {} as never,
          admission: {
            projectId: "project-a",
            documentId,
            generation: "2",
            bind: async () => ({
              projectId: "project-a",
              documentId,
              generation: "2",
              session,
              release() {},
            }),
          },
        };
      }),
    };
    let show!: (documentId: string) => void;
    const seen: Array<{ documentId: string; session: DocumentSession | null }> = [];
    function Harness() {
      const [documentId, setDocumentId] = useState("document-a");
      show = setDocumentId;
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextTabSessionBoundary projectId="project-a" documentId={documentId}>
            {(session) => {
              seen.push({ documentId, session });
              return null;
            }}
          </ContextTabSessionBoundary>
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await vi.waitFor(() => expect(seen.at(-1)?.session).toBe(sessionA));

      await act(async () => show("document-b"));
      expect(
        seen.some(({ documentId, session }) => documentId === "document-b" && session === sessionA),
      ).toBe(false);

      await act(async () => releaseB());
      await vi.waitFor(() => expect(seen.at(-1)?.session).toBe(sessionB));
    });
  });
});
