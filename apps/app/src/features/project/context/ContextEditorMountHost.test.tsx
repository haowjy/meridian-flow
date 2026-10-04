// @vitest-environment jsdom
/** Resource-session fallback and recovery behavior at the desktop editor host. */

import type { ResourceProjectionSnapshot } from "@meridian/resource-replica";
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

vi.mock("./account-feature-context", () => ({
  useAccountResourceReplica: () => resourceReplica,
  useAccountResourceProjection: () => ({ records: [], snapshot: null, error: null }),
}));

import { ContextTabSessionBoundary, resourceAvailabilityRevision } from "./ContextEditorMountHost";

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

  it("does not treat an unrelated catalog revision as document availability", () => {
    const resource = {
      identity: { documentId: "document-a" },
      revision: 4,
      lifecycle: { kind: "acknowledged", availabilityGeneration: "9" },
    };
    const snapshot = (catalogRevision: number) =>
      ({
        records: [{ resource }],
        catalogs: [{ scope: "project", revision: catalogRevision }],
      }) as unknown as ResourceProjectionSnapshot;

    expect(resourceAvailabilityRevision(snapshot(1), "document-a")).toBe(
      resourceAvailabilityRevision(snapshot(2), "document-a"),
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

  it("keeps a warm cached editor mounted while its availability is reprobed", async () => {
    const cachedSession = session();
    let finishReprobe!: () => void;
    const reprobe = new Promise<void>((resolve) => {
      finishReprobe = resolve;
    });
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    resourceReplica.keyForDocument.mockResolvedValue({ handle: "resource-a" });
    resourceReplica.openDocument
      .mockResolvedValueOnce({
        kind: "opened",
        handle: { session: cachedSession, release: firstRelease },
      })
      .mockImplementationOnce(async () => {
        await reprobe;
        return {
          kind: "opened",
          handle: { session: cachedSession, release: secondRelease },
        };
      });
    const opener = { open: vi.fn() };
    let advanceAvailability!: () => void;
    const observed: Array<DocumentSession | null> = [];

    function Harness() {
      const [revision, setRevision] = useState("document-1");
      advanceAvailability = () => setRevision("document-2");
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextTabSessionBoundary
            projectId="project-a"
            documentId="document-a"
            availabilityRevision={revision}
          >
            {(value) => {
              observed.push(value);
              return null;
            }}
          </ContextTabSessionBoundary>
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      expect(observed.at(-1)).toBe(cachedSession);
      const observationsBeforeReprobe = observed.length;

      await act(async () => advanceAvailability());
      expect(observed.slice(observationsBeforeReprobe)).not.toContain(null);
      expect(observed.at(-1)).toBe(cachedSession);
      expect(firstRelease).not.toHaveBeenCalled();

      await act(async () => {
        finishReprobe();
        await reprobe;
      });
      await act(async () => undefined);
      expect(observed.at(-1)).toBe(cachedSession);
      expect(firstRelease).toHaveBeenCalledOnce();
    });
    expect(secondRelease).toHaveBeenCalledOnce();
  });

  it("releases a warm cached editor when its availability becomes terminal", async () => {
    const cachedSession = session();
    const release = vi.fn();
    resourceReplica.keyForDocument.mockResolvedValue({ handle: "resource-a" });
    resourceReplica.openDocument
      .mockResolvedValueOnce({
        kind: "opened",
        handle: { session: cachedSession, release },
      })
      .mockResolvedValueOnce({ kind: "unavailable", reason: "terminal" });
    const opener = { open: vi.fn(async () => ({ kind: "unavailable" })) };
    let advanceAvailability!: () => void;
    const observed: Array<DocumentSession | null> = [];

    function Harness() {
      const [revision, setRevision] = useState("document-1");
      advanceAvailability = () => setRevision("document-2");
      return (
        <ProjectDocumentLiveOpenerContext.Provider value={opener as never}>
          <ContextTabSessionBoundary
            projectId="project-a"
            documentId="document-a"
            availabilityRevision={revision}
          >
            {(value) => {
              observed.push(value);
              return null;
            }}
          </ContextTabSessionBoundary>
        </ProjectDocumentLiveOpenerContext.Provider>
      );
    }

    await withReactRoot(<Harness />, async () => {
      await act(async () => undefined);
      expect(observed.at(-1)).toBe(cachedSession);

      await act(async () => advanceAvailability());
      await act(async () => undefined);

      expect(release).toHaveBeenCalledOnce();
      expect(observed.at(-1)).toBeNull();
    });
  });
});
