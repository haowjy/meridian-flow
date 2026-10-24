import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  AvailabilityGeneration,
  CatalogFileEntry,
  GetDocumentTrashResponse,
  LiveDocumentSessionLease,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import {
  type ResourcePlacement,
  type ResourceRecord,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { getTrashedDocument } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { DocumentSession } from "@/core/editor/document-session";
import { DocumentSessionAuthorityError } from "@/core/editor/document-session-coordination-contract";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
/**
 * Opening a project document by id — the app's one answer to "take me there".
 *
 * Doors that already render a catalog row carry its identity; id-only doors
 * resolve one. Both commit a tab and route before the destination acquires its
 * live session, so availability work cannot hold navigation hostage.
 *
 * Two dispositions, because a writer who asked for a new tab did not ask to
 * leave the sentence they are in: `current` moves the pane to the document,
 * and `background` opens it on the tab strip and stays put. There is no
 * browser-tab disposition — the manuscript is a live collaborative session,
 * and a second window on it costs the writer their place to reach a document
 * that was already one tab away.
 */

import {
  type ContextOwner,
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
import type { CatalogFile } from "@/client/query/context-catalog-projection";
import {
  accessibleResourceCatalogView,
  aggregateCatalogScope,
  projectCatalogFile,
  projectCatalogView,
} from "@/client/query/useContextCatalog";
import {
  type ContextTab,
  isEditorScheme,
  type ServerContextTab,
  useContextTabsActions,
  useContextTabsStore,
} from "@/client/stores";
import { useDockDocumentStore } from "../dock/dock-document-store";
import { type OpenContextRoute, useOpenContextRoute } from "../routing/ProjectNavigationContext";
import {
  useOptionalAccountResourceReplica,
  useOptionalContextRemovalCoordinator,
} from "./account-feature-context";
import { contextTabFromFile, serverTabFromFile } from "./context-tab-from-file";
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
      reason:
        | "deleted"
        | "authority-unavailable"
        | "not-visible"
        | "indeterminate"
        | "failed"
        // The registry's own refusal, kept so the cause is not folded into "failed".
        | DocumentSessionAuthorityError["kind"];
    };

export type ProjectDocumentLiveOpenRequest = {
  source: "server";
  projectId: ProjectId;
  documentId: DocumentId;
  signal?: AbortSignal;
};

type ExactOpenResolution = ProjectContextIdentityResolution | { kind: "failed" | "malformed" };
export type AvailableOpenResolution = Extract<ExactOpenResolution, { kind: "available" }>;
export type TransferToken = { readonly id: string; readonly tabInstanceId: string };
type TransferPlacement = "editor" | "dock";

/** Exact-resolution application operation, independent from navigation effects. */
export class ProjectDocumentLiveOpener {
  private readonly transfers = new Map<
    string,
    { token: TransferToken; resolution: AvailableOpenResolution }
  >();
  private dockTransfer: TransferToken | null = null;
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
  ) {
    dependencies.epochSignal.addEventListener("abort", () => this.transfers.clear(), {
      once: true,
    });
  }

  async resolveIdentity(
    projectId: ProjectId,
    documentId: DocumentId,
  ): Promise<ExactOpenResolution> {
    try {
      return await this.dependencies.availability.resolveForOpen(projectId, documentId);
    } catch {
      return { kind: "failed" };
    }
  }

  replaceTransfer(
    tabInstanceId: string,
    resolution: AvailableOpenResolution | undefined,
    placement?: TransferPlacement,
  ): TransferToken | null {
    if (placement === "dock" && this.dockTransfer) this.disposeTransfer(this.dockTransfer);
    const prior = this.transfers.get(tabInstanceId);
    if (prior) this.disposeTransfer(prior.token);
    if (!resolution) return null;
    const token = Object.freeze({ id: crypto.randomUUID(), tabInstanceId });
    this.transfers.set(tabInstanceId, { token, resolution });
    if (placement === "dock") this.dockTransfer = token;
    return token;
  }

  transferToken(tabInstanceId: string, documentId: string): TransferToken | null {
    const transfer = this.transfers.get(tabInstanceId);
    return transfer?.resolution.documentId === documentId ? transfer.token : null;
  }

  takeTransfer(tabInstanceId: string, documentId: string): AvailableOpenResolution | null {
    const transfer = this.transfers.get(tabInstanceId);
    if (!transfer || transfer.resolution.documentId !== documentId) return null;
    this.transfers.delete(tabInstanceId);
    if (this.dockTransfer === transfer.token) this.dockTransfer = null;
    return transfer.resolution;
  }

  disposeTransfer(token: TransferToken): void {
    if (this.transfers.get(token.tabInstanceId)?.token === token)
      this.transfers.delete(token.tabInstanceId);
    if (this.dockTransfer === token) this.dockTransfer = null;
  }

  pruneTransfers(activeTabInstanceIds: ReadonlySet<string>): void {
    for (const transfer of this.transfers.values()) {
      if (!activeTabInstanceIds.has(transfer.token.tabInstanceId))
        this.disposeTransfer(transfer.token);
    }
  }

  async open(
    input: ProjectDocumentLiveOpenRequest & {
      attempt?: "first" | "retry";
      resolution?: AvailableOpenResolution;
    },
  ): Promise<ProjectDocumentLiveOpenResult> {
    if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
      return { kind: "cancelled" };
    const resolution =
      input.attempt !== "retry" && input.resolution
        ? input.resolution
        : await this.resolveIdentity(input.projectId, input.documentId);
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
    } catch (error) {
      if (input.signal?.aborted || this.dependencies.epochSignal.aborted)
        return { kind: "cancelled" };
      return {
        kind: "unavailable",
        reason: error instanceof DocumentSessionAuthorityError ? error.kind : "failed",
      };
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
          let session = registry.get(lease);
          const snapshot = session.getSnapshot();
          if (
            snapshot.status === "access-lost" ||
            snapshot.connectionState?.kind === "unauthorized" ||
            snapshot.connectionState?.kind === "terminal" ||
            session.resetDisposition === "removed"
          ) {
            await registry.restartUnavailableRoom(lease);
            session = registry.get(lease);
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

export type KnownDocumentIdentity = {
  scheme: ProjectContextTreeScheme;
  workId?: string | null;
  rootThreadId?: string;
  chatId?: string;
  file: CatalogFile;
};

export type OpenProjectDocumentRequest = {
  documentId: string;
  known?: KnownDocumentIdentity;
  /** Omitted keeps the current Editor Work; Work-scoped files always use their resolved owner row. */
  workId?: string;
  disposition?: "current" | "background";
  beside?: (
    tab: ServerContextTab,
    focus?: true,
  ) => { kind: "opened"; tab: ContextTab } | { kind: "cancelled" };
  focus?: true;
  signal?: AbortSignal;
};

export type OpenDocumentPlacement = "editor" | "dock" | "background";
export type OpenDocumentOutcome =
  | { kind: "committed"; documentId: string; placement: OpenDocumentPlacement }
  | { kind: "trashed"; documentId: string }
  | { kind: "cancelled" }
  | { kind: "refused"; reason: "gone" | "no-viewer" | "lookup-failed" };
export type OpenProjectDocument = (
  request: OpenProjectDocumentRequest,
) => Promise<OpenDocumentOutcome>;

type NavigationAdapterDependencies = {
  opener: Pick<ProjectDocumentLiveOpener, "resolveIdentity" | "replaceTransfer">;
  openTab(
    projectId: string,
    tab: ReturnType<typeof contextTabFromFile>,
    isCurrent?: () => boolean,
  ): import("@/client/stores").OpenEditorTabResult;
  openRoute: OpenContextRoute | null;
  captureNavigation?: () => () => boolean;
  openTrash(documentId: string, document: GetDocumentTrashResponse): Promise<unknown>;
  resources?: Pick<
    import("@/core/resources/account-resource-replica").AccountResourceReplica,
    "accountId" | "readProjectionState"
  > | null;
  reconcileInstalledTab?: (projectId: string, tab: ContextTab) => void;
};

function identityForRecord(
  projectId: string,
  record: ResourceRecord,
  placement: ResourcePlacement,
): KnownDocumentIdentity | null {
  const location = placement.resourceLocation(record);
  if (!location) return null;
  const scope = aggregateCatalogScope(projectId, location.scheme, location);
  if (!scope) return null;
  const projected = accessibleResourceCatalogView(projectId, scope, record, placement);
  const file = projectCatalogView(projectId, location.scheme, projected, placement, [
    record,
  ]).findDocument(record.resource.identity.documentId);
  if (!file || projected.entries.get(record.resource.identity.documentId)?.kind !== "file")
    return null;
  if (location.chatId !== undefined) {
    const spelled = parseContextUri(file.uri);
    if (!spelled.ok || spelled.value.authority.kind !== "chat") return null;
  }
  return {
    scheme: location.scheme,
    workId: location.workId,
    rootThreadId: location.rootThreadId,
    chatId: location.chatId,
    file,
  };
}

type CommitResult =
  | { kind: "applied"; placement: OpenDocumentPlacement }
  | { kind: "cancelled" }
  | { kind: "no-viewer" }
  | { kind: "failed" };

/** Turns a document identity into a committed destination; the destination owns content. */
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
    {
      documentId,
      known,
      workId,
      disposition = "current",
      beside,
      focus,
      signal,
    }: OpenProjectDocumentRequest,
  ): Promise<OpenDocumentOutcome> {
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
      const projection = this.dependencies.resources?.readProjectionState(projectId);
      const record =
        projection?.kind === "ready"
          ? projection.snapshot.records.find(
              (candidate) => candidate.resource.identity.documentId === documentId,
            )
          : undefined;
      if (record?.resource.lifecycle.kind === "terminal")
        return this.openTrash(projectId, documentId, controller.signal, isCurrent);

      let identity = known;
      if (!identity && projection?.kind === "ready" && record) {
        identity =
          identityForRecord(
            projectId,
            record,
            resourcePlacementForSnapshot(projectId, projection.snapshot),
          ) ?? undefined;
      }

      let transfer: AvailableOpenResolution | undefined;
      if (!identity) {
        const resolution = await this.dependencies.opener.resolveIdentity(projectId, documentId);
        if (!isCurrent()) return { kind: "cancelled" };
        if (resolution.kind === "deleted")
          return this.openTrash(projectId, documentId, controller.signal, isCurrent);
        if (resolution.kind !== "available") {
          return {
            kind: "refused",
            reason: resolution.kind === "not-visible" ? "gone" : "lookup-failed",
          };
        }
        transfer = resolution;
        const scheme = schemeForEntry(resolution.entry);
        if (!scheme) return { kind: "refused", reason: "lookup-failed" };
        identity = {
          scheme,
          file: projectCatalogFile(resolution.entry),
          workId: resolution.entry.scope.kind === "work" ? resolution.entry.scope.workId : workId,
          rootThreadId:
            resolution.entry.scope.kind === "lineage"
              ? resolution.entry.scope.rootThreadId
              : undefined,
          chatId:
            resolution.entry.scope.kind === "chat" ? resolution.entry.scope.chatId : undefined,
        };
      }

      if (disposition === "current" && !this.dependencies.openRoute)
        throw new Error("Opening a project document requires the project route owner");
      const committed = await this.commitFile({
        projectId,
        scheme: identity.scheme,
        file: identity.file,
        routeWorkId: identity.workId ?? workId,
        rootThreadId: identity.rootThreadId,
        chatId: identity.chatId,
        disposition,
        beside,
        focus,
        isCurrent,
        canCommit,
        transfer,
      });
      if (committed.kind === "failed") return { kind: "refused", reason: "lookup-failed" };
      if (committed.kind === "no-viewer") return { kind: "refused", reason: "no-viewer" };
      return committed.kind === "applied"
        ? { kind: "committed", documentId, placement: committed.placement }
        : { kind: "cancelled" };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
      if (this.current === controller) this.current = null;
    }
  }

  private async openTrash(
    projectId: string,
    documentId: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<OpenDocumentOutcome> {
    let document: GetDocumentTrashResponse;
    try {
      document = await getTrashedDocument(projectId, documentId, { signal });
    } catch {
      return signal.aborted ? { kind: "cancelled" } : { kind: "refused", reason: "gone" };
    }
    if (!isCurrent()) return { kind: "cancelled" };
    await this.dependencies.openTrash(documentId, document);
    return { kind: "trashed", documentId };
  }

  private async commitFile(input: {
    projectId: string;
    scheme: ProjectContextTreeScheme;
    file: CatalogFile;
    routeWorkId: string | undefined;
    rootThreadId?: string;
    chatId?: string;
    disposition: "current" | "background";
    beside?: OpenProjectDocumentRequest["beside"];
    focus?: true;
    isCurrent: () => boolean;
    canCommit: () => boolean;
    transfer?: AvailableOpenResolution;
  }): Promise<CommitResult> {
    const owner: ContextOwner = input.chatId
      ? { chatThreadId: input.chatId }
      : input.rootThreadId
        ? { rootThreadId: input.rootThreadId }
        : { workId: input.routeWorkId ?? null };
    const tab = isEditorScheme(input.scheme)
      ? {
          ...contextTabFromFile(input.scheme, input.file, owner),
          tabInstanceId: crypto.randomUUID(),
        }
      : undefined;
    if (!input.isCurrent()) return { kind: "cancelled" };

    if (input.disposition === "current" && input.beside) {
      let besideTab: ServerContextTab | null = null;
      try {
        besideTab = serverTabFromFile(input.scheme, input.file, owner);
        if (besideTab) besideTab = { ...besideTab, tabInstanceId: tab?.tabInstanceId };
      } catch {
        besideTab = null;
      }
      if (besideTab) {
        const placed = input.beside(besideTab, input.focus);
        this.current = null;
        if (placed.kind === "opened" && placed.tab.tabInstanceId)
          this.dependencies.opener.replaceTransfer(
            placed.tab.tabInstanceId,
            input.transfer,
            "dock",
          );
        return placed.kind === "opened"
          ? { kind: "applied", placement: "dock" }
          : { kind: "cancelled" };
      }
    }

    if (input.disposition === "current") {
      if (input.scheme === "uploads") {
        this.current = null;
        return { kind: "no-viewer" };
      }
      if (!this.dependencies.openRoute)
        throw new Error("Opening a project document requires the project route owner");
      this.current = null;
      const settlement = await this.dependencies.openRoute(
        {
          scheme: input.scheme,
          path: input.file.path,
          workId: input.rootThreadId ? undefined : input.routeWorkId,
          ...(input.rootThreadId ? { rootThreadId: input.rootThreadId } : {}),
          documentId: input.file.documentId,
        },
        {
          tab,
          ...(input.focus ? { focus: true as const } : {}),
          isCurrent: input.isCurrent,
          canCommit: input.canCommit,
          afterCommit: (installed) => {
            if (installed?.tabInstanceId) {
              this.dependencies.opener.replaceTransfer(
                installed.tabInstanceId,
                input.transfer,
                "editor",
              );
              this.dependencies.reconcileInstalledTab?.(input.projectId, installed);
            }
          },
        },
      );
      return settlement.kind === "failed"
        ? { kind: "failed" }
        : settlement.kind === "applied"
          ? { kind: "applied", placement: "editor" }
          : { kind: "cancelled" };
    }

    if (tab) {
      const installed = this.dependencies.openTab(input.projectId, tab, input.isCurrent);
      if (installed.kind !== "opened")
        return installed.kind === "superseded" ? { kind: "cancelled" } : { kind: "failed" };
    }
    return input.canCommit() ? { kind: "applied", placement: "background" } : { kind: "cancelled" };
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const opener = useProjectDocumentLiveOpener();
  const resources = useOptionalAccountResourceReplica();
  const removal = useOptionalContextRemovalCoordinator();
  const openContextRoute = useOpenContextRoute();
  const { openTab } = useContextTabsActions();
  const openTrash = useCallback(
    (documentId: string, document: GetDocumentTrashResponse) => {
      queryClient.setQueryData(projectQueryKeys.trashedDocument(projectId, documentId), document);
      return navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({ ...previous, trash: documentId }),
        state: (previous) => previous,
      });
    },
    [navigate, projectId, queryClient],
  );
  useEffect(() => {
    if (!resources) return;
    return resources.observeProjection(
      projectId,
      () => undefined,
      () => undefined,
    );
  }, [projectId, resources]);
  useEffect(() => {
    const prune = () => {
      const active = new Set<string>();
      for (const project of Object.values(useContextTabsStore.getState().byProject)) {
        for (const tab of project.tabs) if (tab.tabInstanceId) active.add(tab.tabInstanceId);
      }
      const dock = useDockDocumentStore.getState();
      for (const document of [dock.occupant, dock.restoring]) {
        if (document?.tab.tabInstanceId) active.add(document.tab.tabInstanceId);
      }
      opener.pruneTransfers(active);
    };
    const stopTabs = useContextTabsStore.subscribe(prune);
    const stopDock = useDockDocumentStore.subscribe(prune);
    prune();
    return () => {
      stopTabs();
      stopDock();
    };
  }, [opener]);
  const owner = useMemo<ProjectDocumentNavigationOwner>(
    () => ({
      projectId,
      adapter: new ProjectDocumentNavigationAdapter({
        opener,
        openTab,
        openRoute: openContextRoute,
        captureNavigation,
        openTrash,
        resources,
        reconcileInstalledTab: (installedProjectId, tab) =>
          removal?.reconcileInstalledTab(installedProjectId, tab),
      }),
    }),
    [
      openContextRoute,
      openTab,
      openTrash,
      opener,
      projectId,
      captureNavigation,
      removal,
      resources,
    ],
  );
  useEffect(() => () => owner.adapter.dispose(), [owner]);

  return createElement(ProjectDocumentNavigationContext.Provider, { value: owner }, children);
}

export function useOpenProjectDocument(projectId: string | undefined): OpenProjectDocument {
  const owner = useContext(ProjectDocumentNavigationContext);

  return useCallback(
    async (request) => {
      if (!projectId || owner?.projectId !== projectId)
        return { kind: "refused", reason: "lookup-failed" };
      return owner.adapter.open(projectId, request);
    },
    [owner, projectId],
  );
}

/** Current project-route identity for authorization-only projections. */
export function useProjectDocumentNavigationProjectId(): string | null {
  return useContext(ProjectDocumentNavigationContext)?.projectId ?? null;
}
