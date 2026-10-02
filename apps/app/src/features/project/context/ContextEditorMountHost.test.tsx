// @vitest-environment jsdom
/** Resource-session fallback and recovery behavior at the desktop editor host. */
import { act, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentSession } from "@/core/editor/document-session";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { AdmittedLiveDocument } from "./open-project-document";
import { ProjectDocumentLiveOpenerContext } from "./project-document-live-opener-context";

const resourceReplica = vi.hoisted(() => ({
  keyForDocument: vi.fn(),
  openDocument: vi.fn(),
  captureServerSession: vi.fn(async () => undefined),
}));
const liveHost = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => resourceReplica,
  useAccountResourceProjection: () => ({ records: [], snapshot: null, error: null }),
}));
vi.mock("../dock/editor-review-handoff", () => ({
  useLiveBindingAcknowledgementHost: (...args: unknown[]) => liveHost.register(...args),
}));
vi.mock("../draft-apply-recovery/ProjectDraftApplyRecoveryExecutor", () => ({
  usePostApplyHostWake: () => undefined,
}));

import { ContextTabSessionBoundary } from "./ContextEditorMountHost";

function session(): DocumentSession {
  return {
    getSnapshot: () => ({ status: "synced", schemaFence: null }),
  } as unknown as DocumentSession;
}

function admission(boundSession: DocumentSession): AdmittedLiveDocument {
  return {
    projectId: "project-a",
    documentId: "document-a",
    generation: "2",
    bind: async () => ({
      projectId: "project-a",
      documentId: "document-a",
      generation: "2",
      session: boundSession,
      release: vi.fn(),
    }),
  };
}

describe("ContextTabSessionBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not claim a live admission while a draft-only branch is mounted", async () => {
    const draftSession = session();
    resourceReplica.keyForDocument.mockResolvedValue({ handle: "resource-a" });
    resourceReplica.openDocument.mockResolvedValue({
      kind: "opened",
      handle: { session: draftSession, release: vi.fn() },
    });
    const opener = { open: vi.fn() };

    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <ContextTabSessionBoundary
          projectId="project-a"
          documentId="document-a"
          availabilityRevision="catalog-1"
          claimLiveAdmission={false}
        >
          {() => null}
        </ContextTabSessionBoundary>
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        expect(liveHost.register.mock.calls.at(-1)?.[1]).toBeNull();
      },
    );
  });

  it("falls through a stale local-resource failure to authoritative server admission", async () => {
    const serverSession = session();
    resourceReplica.keyForDocument.mockResolvedValue({ handle: "resource-a" });
    resourceReplica.openDocument.mockResolvedValue({ kind: "unavailable", reason: "changed" });
    const opener = {
      open: vi.fn(async () => ({ kind: "opened", admission: admission(serverSession) })),
    };
    const observed: Array<{ value: DocumentSession | null; failed: boolean }> = [];

    await withReactRoot(
      <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
        <ContextTabSessionBoundary
          projectId="project-a"
          documentId="document-a"
          availabilityRevision="catalog-1"
        >
          {(value, failed) => {
            observed.push({ value, failed });
            return null;
          }}
        </ContextTabSessionBoundary>
      </ProjectDocumentLiveOpenerContext.Provider>,
      async () => {
        await act(async () => undefined);
        expect(opener.open).toHaveBeenCalledOnce();
        expect(observed.at(-1)).toEqual({ value: serverSession, failed: false });
      },
    );
  });

  it("retries a genuine server failure when catalog authority advances", async () => {
    const serverSession = session();
    resourceReplica.keyForDocument.mockResolvedValue({ handle: "resource-a" });
    resourceReplica.openDocument.mockResolvedValue({ kind: "unavailable", reason: "changed" });
    const opener = {
      open: vi
        .fn()
        .mockResolvedValueOnce({ kind: "unavailable" })
        .mockResolvedValueOnce({ kind: "unavailable" })
        .mockResolvedValue({ kind: "opened", admission: admission(serverSession) }),
    };
    let advanceCatalog!: () => void;
    let retry!: () => void;
    const observed: Array<{ value: DocumentSession | null; failed: boolean }> = [];

    function Harness() {
      const [revision, setRevision] = useState("catalog-1");
      advanceCatalog = () => setRevision("catalog-2");
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextTabSessionBoundary
            projectId="project-a"
            documentId="document-a"
            availabilityRevision={revision}
          >
            {(value, failed, _localContentReady, retryBinding) => {
              retry = retryBinding;
              observed.push({ value, failed });
              return null;
            }}
          </ContextTabSessionBoundary>
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      expect(observed.at(-1)).toMatchObject({ value: null, failed: true });
      await act(async () => retry());
      await act(async () => undefined);
      expect(opener.open).toHaveBeenCalledTimes(2);
      expect(observed.at(-1)).toMatchObject({ value: null, failed: true });
      await act(async () => advanceCatalog());
      await act(async () => undefined);
      expect(resourceReplica.openDocument).toHaveBeenCalledTimes(2);
      expect(opener.open).toHaveBeenCalledTimes(3);
      expect(observed.at(-1)).toEqual({ value: serverSession, failed: false });
    });
  });
});
