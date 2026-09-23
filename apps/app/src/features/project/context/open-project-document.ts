import type {
  AvailabilityGeneration,
  CatalogFileEntry,
  LiveDocumentSessionLease,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { projectResourceLocation, type ResourceRecord } from "@meridian/resource-replica";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
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
  isWorkScopedProjectContextScheme,
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
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import {
  accessibleResourceCatalogView,
  contextCatalogScope,
  projectCatalogFile,
  projectCatalogView,
} from "@/client/query/useContextCatalog";
import { useContextTabsActions } from "@/client/stores";
import { type OpenContextRoute, useOpenContextRoute } from "../routing/ProjectNavigationContext";
import { useOptionalAccountResourceReplica } from "./account-feature-context";
import { contextTabFromFile } from "./context-tab-from-file";
import { useProjectDocumentLiveOpener } from "./project-document-live-opener-context";

export interface LiveDocumentBinding {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  readonly generation: AvailabilityGeneration;
  readonly session: DocumentSession;
  readonly local?: true;
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

export type ProjectDocumentLiveOpenRequest = {
  source: "server";
  projectId: ProjectId;
  documentId: DocumentId;
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
      lease = await this.dependencies.registry.admit(
        input.projectId,
        input.documentId,
        resolution.generation,
      );
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
  /** Host Work context for project-scoped files; resolved Work/no-Work authority wins. */
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
  openTab(
    projectId: string,
    tab: ReturnType<typeof contextTabFromFile>,
    isCurrent?: () => boolean,
  ): import("@/client/stores").OpenEditorTabResult;
  openRoute: OpenContextRoute | null;
  captureNavigation?: () => () => boolean;
  resources?: {
    readonly accountId: string;
    openKnownDocument(
      projectId: string,
      documentId: string,
      participantId: string,
      signal?: AbortSignal,
    ): ReturnType<
      import("@/core/resources/account-resource-replica").AccountResourceReplica["openKnownDocument"]
    >;
    openDocument: import("@/core/resources/account-resource-replica").AccountResourceReplica["openDocument"];
  } | null;
};

function localFileForRecord(
  projectId: string,
  record: ResourceRecord,
): {
  scheme: ProjectContextTreeScheme;
  workId: string | null;
  file: CatalogFile;
  entry: CatalogFileEntry;
} | null {
  if (record.resource.content.kind !== "exact") return null;
  const location = projectResourceLocation(projectId, record);
  if (!location) return null;
  const scope = contextCatalogScope(projectId, location.scheme, location.workId);
  if (!scope) return null;
  const projected = accessibleResourceCatalogView(projectId, scope, record);
  const file = projectCatalogView(projectId, location.scheme, projected, [record]).findDocument(
    record.resource.identity.documentId,
  );
  const entry = projected.entries.get(record.resource.identity.documentId);
  if (!file || entry?.kind !== "file") return null;
  return {
    scheme: location.scheme,
    workId: location.workId,
    file,
    entry,
  };
}

/** Latest-attempt navigation: editable files admit sessions; not-editable results open viewers. */
export class ProjectDocumentNavigationAdapter {
  private attempt = 0;
  private current: AbortController | null = null;
  private readonly pending = new Set<AbortController>();

  constructor(private readonly dependencies: NavigationAdapterDependencies) {}

  dispose(): void {
    this.attempt += 1;
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    this.current = null;
  }

  async open(
    projectId: string,
    { documentId, workId = null, disposition = "current", signal }: OpenProjectDocumentRequest,
  ): Promise<ProjectDocumentLiveOpenResult> {
    const navigationIsCurrent =
      disposition === "current" ? this.dependencies.captureNavigation?.() : undefined;
    const token = disposition === "current" ? ++this.attempt : this.attempt;
    const controller = new AbortController();
    this.pending.add(controller);
    if (disposition === "current") {
      this.current?.abort();
      this.current = controller;
    }
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const canCommit = () =>
      !controller.signal.aborted && (disposition === "background" || token === this.attempt);
    const isCurrent = () => canCommit() && navigationIsCurrent?.() !== false;
    try {
      const local = this.dependencies.resources
        ? await this.dependencies.resources.openKnownDocument(
            projectId,
            documentId,
            `navigation:${crypto.randomUUID()}`,
            controller.signal,
          )
        : ({ kind: "missing" } as const);
      if (local.kind === "cancelled") return { kind: "cancelled" };
      if (local.kind === "opened") {
        const prepared = local.handle;
        try {
          const resolved = localFileForRecord(projectId, local.record);
          if (!resolved) return { kind: "unavailable", reason: "deleted" };
          if (!isCurrent()) return { kind: "cancelled" };
          const committed = await this.commitFile({
            projectId,
            scheme: resolved.scheme,
            file: resolved.file,
            routeWorkId: resolved.workId ?? workId,
            disposition,
            isCurrent,
            canCommit,
          });
          if (committed !== "applied")
            return committed === "failed"
              ? { kind: "unavailable", reason: "failed" }
              : { kind: "cancelled" };
          const resources = this.dependencies.resources;
          if (!resources) return { kind: "unavailable", reason: "failed" };
          const generation = String(local.record.resource.identity.revision);
          return {
            kind: "opened",
            document: resolved.entry,
            admission: {
              projectId,
              documentId: resolved.file.documentId,
              generation,
              bind: async (ownerId) => {
                const rebound = await resources.openDocument(
                  projectId,
                  local.key,
                  ownerId,
                  undefined,
                  { adoptionEligible: true },
                );
                if (rebound.kind !== "opened")
                  throw new Error("Local document content is unavailable");
                return {
                  projectId,
                  documentId: rebound.handle.documentId,
                  generation,
                  session: rebound.handle.session,
                  local: true,
                  release: rebound.handle.release,
                };
              },
            },
          };
        } finally {
          prepared.release();
        }
      }
      if (
        local.kind === "unavailable" &&
        (local.record.resource.lifecycle.kind !== "acknowledged" ||
          !projectResourceLocation(projectId, local.record))
      )
        return {
          kind: "unavailable",
          reason: local.reason === "deleted" || local.reason === "terminal" ? "deleted" : "failed",
        };
      const result = await this.dependencies.opener.open({
        source: "server",
        projectId,
        documentId,
        signal: controller.signal,
      });
      if (!isCurrent()) return { kind: "cancelled" };
      if (result.kind !== "opened" && result.kind !== "not-editable") return result;

      const scheme = schemeForEntry(result.document);
      if (!scheme) return { kind: "unavailable", reason: "failed" };
      const routeWorkId =
        result.document.scope.kind === "work" ? result.document.scope.workId : workId;
      const file = projectCatalogFile(result.document);
      if (disposition === "current" && !this.dependencies.openRoute) {
        throw new Error("Opening a project document requires the project route owner");
      }
      const committed = await this.commitFile({
        projectId,
        scheme,
        file,
        routeWorkId,
        disposition,
        isCurrent,
        canCommit,
      });
      if (committed === "failed") return { kind: "unavailable", reason: "failed" };
      return committed === "applied" ? result : { kind: "cancelled" };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
      if (this.current === controller) this.current = null;
    }
  }

  private async commitFile(input: {
    projectId: string;
    scheme: ProjectContextTreeScheme;
    file: CatalogFile;
    routeWorkId: string | null;
    disposition: "current" | "background";
    isCurrent: () => boolean;
    canCommit: () => boolean;
  }): Promise<"applied" | "cancelled" | "failed"> {
    const tab = isWorkScopedProjectContextScheme(input.scheme)
      ? undefined
      : contextTabFromFile(input.scheme, input.file, input.routeWorkId);
    if (!input.isCurrent()) return "cancelled";
    if (input.disposition === "current") {
      if (!this.dependencies.openRoute)
        throw new Error("Opening a project document requires the project route owner");
      this.current = null;
      const settlement = await this.dependencies.openRoute(
        {
          scheme: input.scheme,
          path: input.file.path,
          workId: input.routeWorkId,
          documentId: input.file.documentId,
        },
        { tab, isCurrent: input.isCurrent, canCommit: input.canCommit },
      );
      return settlement.kind === "failed"
        ? "failed"
        : settlement.kind === "applied"
          ? "applied"
          : "cancelled";
    }
    if (tab) {
      const installed = this.dependencies.openTab(input.projectId, tab, input.isCurrent);
      if (installed.kind !== "opened")
        return installed.kind === "superseded" ? "cancelled" : "failed";
    }
    return input.canCommit() ? "applied" : "cancelled";
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
  captureNavigation,
}: {
  projectId: string;
  children: ReactNode;
  captureNavigation?: () => () => boolean;
}) {
  const opener = useProjectDocumentLiveOpener();
  const resources = useOptionalAccountResourceReplica();
  const openContextRoute = useOpenContextRoute();
  const { openTab } = useContextTabsActions();
  const owner = useMemo<ProjectDocumentNavigationOwner>(
    () => ({
      projectId,
      adapter: new ProjectDocumentNavigationAdapter({
        opener,
        openTab,
        openRoute: openContextRoute,
        captureNavigation,
        resources,
      }),
    }),
    [openContextRoute, openTab, opener, projectId, captureNavigation, resources],
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
