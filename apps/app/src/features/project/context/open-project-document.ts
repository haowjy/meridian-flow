import type {
  AvailabilityGeneration,
  CatalogFileEntry,
  LiveDocumentSessionLease,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { LocalDocumentSessionAdoptionPort } from "@/core/editor/local-document-session-adoption";
import type { LocalMaterializationReservation } from "./local-untitled-owner";
/**
 * Opening a project document by id — the app's one answer to "take me there".
 *
 * A document id is all a door carries: a change trail's receipt, a search
 * result, a wikilink the writer just followed. Turning that id into an open
 * tab means finding which scheme's tree holds it, and that lookup plus the
 * openTab-and-route pair is the same work every door was about to write for
 * itself.
 *
 * Two dispositions, because a writer who asked for a new tab did not ask to
 * leave the sentence they are in: `current` moves the pane to the document,
 * and `background` opens it on the tab strip and stays put. There is no
 * browser-tab disposition — the manuscript is a live collaborative session,
 * and a second window on it costs the writer their place to reach a document
 * that was already one tab away.
 */

import {
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";

import { projectCatalogFile } from "@/client/query/useContextCatalog";
import { useContextTabsActions } from "@/client/stores";
import { type OpenContextRoute, useProjectContextRoute } from "../routing/ProjectContextRoute";
import { contextTabFromFile } from "./context-tab-from-file";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export interface LiveDocumentBinding {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  readonly generation: AvailabilityGeneration;
  readonly session: DocumentSession;
  release(): void;
}

export interface AdmittedLiveDocument {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  readonly generation: AvailabilityGeneration;
  bind(ownerId: string): Promise<LiveDocumentBinding>;
}

export type ProjectDocumentLiveOpenResult =
  | { kind: "opened"; document: CatalogFileEntry; admission: AdmittedLiveDocument }
  | { kind: "cancelled" }
  | { kind: "not-editable"; document: CatalogFileEntry }
  | {
      kind: "unavailable";
      reason: "deleted" | "authority-unavailable" | "not-visible" | "indeterminate" | "failed";
    };

export type ProjectDocumentLiveOpenRequest =
  | { source: "server"; projectId: ProjectId; documentId: DocumentId; signal?: AbortSignal }
  | {
      source: "recover-local-adoption";
      projectId: ProjectId;
      documentId: DocumentId;
      lineageHandle: string;
      signal?: AbortSignal;
    }
  | {
      source: "local-untitled";
      projectId: ProjectId;
      documentId: DocumentId;
      reservation: LocalMaterializationReservation;
      signal?: AbortSignal;
    };

type ExactOpenResolution = ProjectContextIdentityResolution | { kind: "failed" | "malformed" };

/** Exact-resolution application operation, independent from navigation effects. */
export class ProjectDocumentLiveOpener {
  constructor(
    private readonly dependencies: {
      availability: {
        resolveForOpen(projectId: ProjectId, documentId: DocumentId): Promise<ExactOpenResolution>;
      };
      registry: Pick<
        LiveDocumentSessionRegistry,
        "admit" | "retain" | "get" | "release" | "restartUnavailableRoom"
      >;
      adoption: LocalDocumentSessionAdoptionPort;
      epochSignal: AbortSignal;
    },
  ) {}

  async open(input: ProjectDocumentLiveOpenRequest): Promise<ProjectDocumentLiveOpenResult> {
    if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
      return { kind: "cancelled" };
    let resolution: ExactOpenResolution;
    try {
      resolution = await this.dependencies.availability.resolveForOpen(
        input.projectId,
        input.documentId,
      );
    } catch {
      if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
        return { kind: "cancelled" };
      return { kind: "unavailable", reason: "failed" };
    }
    if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
      return { kind: "cancelled" };
    if (resolution.kind !== "available") {
      const reason =
        resolution.kind === "malformed" || resolution.kind === "failed"
          ? "failed"
          : resolution.kind;
      return { kind: "unavailable", reason };
    }
    if (resolution.documentId !== input.documentId)
      return { kind: "unavailable", reason: "failed" };
    if (!resolution.entry.editable) return { kind: "not-editable", document: resolution.entry };
    if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
      return { kind: "cancelled" };

    let lease: LiveDocumentSessionLease;
    try {
      if (input.source === "server") {
        lease = await this.dependencies.registry.admit(
          input.projectId,
          input.documentId,
          resolution.generation,
        );
      } else if (input.source === "local-untitled") {
        const adopted = await this.dependencies.adoption.bindAndAdopt({
          projectId: input.projectId,
          documentId: input.documentId,
          generation: resolution.generation,
          handoff: input.reservation.handoff,
          pending: input.reservation.pending,
        });
        lease = adopted.lease;
      } else {
        const adopted = await this.dependencies.adoption.recover({
          projectId: input.projectId,
          documentId: input.documentId,
          generation: resolution.generation,
          lineageHandle: input.lineageHandle,
        });
        lease = adopted.lease;
      }
    } catch {
      if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
        return { kind: "cancelled" };
      return { kind: "unavailable", reason: "failed" };
    }
    if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
      return { kind: "cancelled" };
    return {
      kind: "opened",
      document: resolution.entry,
      admission: this.capability(lease),
    };
  }

  private capability(lease: LiveDocumentSessionLease): AdmittedLiveDocument {
    const registry = this.dependencies.registry;
    return Object.freeze({
      projectId: lease.projectId,
      documentId: lease.documentId,
      generation: lease.generation,
      async bind(ownerId: string): Promise<LiveDocumentBinding> {
        registry.retain(ownerId, [lease]);
        try {
          const session = registry.get(lease);
          const snapshot = session.getSnapshot();
          if (
            snapshot.status === "access-lost" ||
            snapshot.connectionState?.kind === "unauthorized" ||
            snapshot.connectionState?.kind === "terminal"
          ) {
            await registry.restartUnavailableRoom(lease);
          }
          let released = false;
          return Object.freeze({
            projectId: lease.projectId,
            documentId: lease.documentId,
            generation: lease.generation,
            session,
            release() {
              if (released) return;
              released = true;
              registry.release(ownerId);
            },
          });
        } catch (error) {
          registry.release(ownerId);
          throw error;
        }
      },
    });
  }
}

export type OpenProjectDocumentRequest = {
  documentId: string;
  /** The work whose scratch to search; without one, work-scoped schemes are skipped. */
  workId?: string | null;
  disposition?: "current" | "background";
  /** Abandons the open when the caller that asked for it is gone. */
  signal?: AbortSignal;
};

export type OpenProjectDocument = (
  request: OpenProjectDocumentRequest,
) => Promise<ProjectDocumentLiveOpenResult>;

type NavigationAdapterDependencies = {
  opener: Pick<ProjectDocumentLiveOpener, "open">;
  openTab(projectId: string, tab: ReturnType<typeof contextTabFromFile>): void;
  openRoute: OpenContextRoute | null;
};

/** Latest-attempt navigation effects over the exact-resolution opener. */
export class ProjectDocumentNavigationAdapter {
  private attempt = 0;
  private current: AbortController | null = null;

  constructor(private readonly dependencies: NavigationAdapterDependencies) {}

  dispose(): void {
    this.attempt += 1;
    this.current?.abort();
    this.current = null;
  }

  async open(
    projectId: string,
    { documentId, workId = null, disposition = "current", signal }: OpenProjectDocumentRequest,
  ): Promise<ProjectDocumentLiveOpenResult> {
    const token = ++this.attempt;
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const result = await this.dependencies.opener.open({
        source: "server",
        projectId,
        documentId,
        signal: controller.signal,
      });
      if (token !== this.attempt || controller.signal.aborted) return { kind: "cancelled" };
      if (result.kind !== "opened") return result;

      const scheme = schemeForEntry(result.document);
      if (!scheme) return { kind: "unavailable", reason: "failed" };
      const routeWorkId =
        result.document.scope.kind === "work" ? result.document.scope.workId : workId;
      const file = projectCatalogFile(result.document);
      if (disposition === "current" && !this.dependencies.openRoute) {
        throw new Error("Opening a project document requires the project route owner");
      }
      this.dependencies.openTab(projectId, contextTabFromFile(scheme, file, routeWorkId));
      if (disposition === "current") {
        await this.dependencies.openRoute?.({
          scheme,
          path: file.path,
          workId: routeWorkId ?? null,
        });
      }
      return token === this.attempt && !controller.signal.aborted ? result : { kind: "cancelled" };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (token === this.attempt) this.current = null;
    }
  }
}

function schemeForEntry(entry: CatalogFileEntry): ProjectContextTreeScheme | null {
  const separator = entry.uri.indexOf(":");
  const scheme = separator < 0 ? "" : entry.uri.slice(0, separator);
  return isProjectContextTreeScheme(scheme) ? scheme : null;
}

type ProjectDocumentNavigationOwner = {
  projectId: string;
  adapter: ProjectDocumentNavigationAdapter;
};

const ProjectDocumentNavigationContext = createContext<ProjectDocumentNavigationOwner | null>(null);

/** Project-route composition owner for every document-opening door in the route. */
export function ProjectDocumentNavigationProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const opener = useProjectDocumentLiveOpener();
  const openContextRoute = useProjectContextRoute();
  const { openTab } = useContextTabsActions();
  const owner = useMemo<ProjectDocumentNavigationOwner>(
    () => ({
      projectId,
      adapter: new ProjectDocumentNavigationAdapter({
        opener,
        openTab,
        openRoute: openContextRoute,
      }),
    }),
    [openContextRoute, openTab, opener, projectId],
  );
  useEffect(() => () => owner.adapter.dispose(), [owner]);

  return createElement(ProjectDocumentNavigationContext.Provider, { value: owner }, children);
}

export function useOpenProjectDocument(projectId: string | undefined): OpenProjectDocument {
  const owner = useContext(ProjectDocumentNavigationContext);

  return useCallback(
    async (request) => {
      if (!projectId || owner?.projectId !== projectId)
        return { kind: "unavailable", reason: "failed" };
      return owner.adapter.open(projectId, request);
    },
    [owner, projectId],
  );
}

/** Current project-route identity for authorization-only projections. */
export function useProjectDocumentNavigationProjectId(): string | null {
  return useContext(ProjectDocumentNavigationContext)?.projectId ?? null;
}
