import { parseContextUri } from "@meridian/contracts/context-uri";
import type {
  AvailabilityGeneration,
  CatalogFileEntry,
  LiveDocumentSessionLease,
  ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import {
  type ResourcePlacement,
  type ResourceProjectionSnapshot,
  type ResourceRecord,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import type { DocumentSession } from "@/core/editor/document-session";
import { DocumentSessionAuthorityError } from "@/core/editor/document-session-coordination-contract";
import type { LiveDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { contextRouteRequest } from "../routing/project-route";
/**
 * Opening a project document by id — the app's one answer to "take me there".
 *
 * Doors that already render a catalog row carry its identity; id-only doors
 * resolve one. Both commit main's address before the destination acquires its
 * live session, so availability work cannot hold navigation hostage. Every
 * door opens the document in main.
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
import { type ContextTab, isEditorScheme } from "@/client/stores";
import {
  type BesideHint,
  type OpenContextRoute,
  useOpenContextRoute,
  useOpenedFromChat,
  useProjectTrashNavigation,
} from "../routing/ProjectNavigationContext";
import {
  useOptionalAccountResourceReplica,
  useOptionalPresentedDocuments,
} from "./account-feature-context";
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
/** A resolved open handed to the host that mounts its document: one host per document. */
export type TransferToken = { readonly id: string; readonly documentId: string };

/** Exact-resolution application operation, independent from navigation effects. */
export class ProjectDocumentLiveOpener {
  private readonly transfers = new Map<
    string,
    { token: TransferToken; resolution: AvailableOpenResolution }
  >();
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
    documentId: string,
    resolution: AvailableOpenResolution | undefined,
  ): TransferToken | null {
    const prior = this.transfers.get(documentId);
    if (prior) this.disposeTransfer(prior.token);
    if (!resolution || resolution.documentId !== documentId) return null;
    const token = Object.freeze({ id: crypto.randomUUID(), documentId });
    this.transfers.set(documentId, { token, resolution });
    return token;
  }

  transferToken(documentId: string): TransferToken | null {
    return this.transfers.get(documentId)?.token ?? null;
  }

  takeTransfer(documentId: string): AvailableOpenResolution | null {
    const transfer = this.transfers.get(documentId);
    if (!transfer) return null;
    this.transfers.delete(documentId);
    return transfer.resolution;
  }

  disposeTransfer(token: TransferToken): void {
    if (this.transfers.get(token.documentId)?.token === token)
      this.transfers.delete(token.documentId);
  }

  /** A transfer no view presents, nor is about to, is let go. */
  pruneTransfers(presentedDocumentIds: ReadonlySet<string>): void {
    for (const transfer of this.transfers.values()) {
      if (!presentedDocumentIds.has(transfer.token.documentId))
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
  /** The caller has already resolved this identity as deleted. */
  trashed?: true;
  /** Ignore a local identity projection known to predate a completed mutation. */
  refreshIdentity?: true;
  known?: KnownDocumentIdentity;
  /** Omitted keeps the current Editor Work; Work-scoped files always use their resolved owner row. */
  workId?: string;
  focus?: true;
  /** Takes the place of the current history entry (main leaving a document the writer removed). */
  replace?: true;
  /** The chat the open was made from: the new entry keeps it beside the document. */
  beside?: BesideHint;
  signal?: AbortSignal;
};

export type OpenDocumentOutcome =
  | { kind: "committed"; documentId: string }
  | { kind: "trashed"; documentId: string }
  | { kind: "cancelled" }
  | { kind: "refused"; reason: "gone" | "no-viewer" | "lookup-failed" };
export type OpenProjectDocument = (
  request: OpenProjectDocumentRequest,
) => Promise<OpenDocumentOutcome>;

type NavigationAdapterDependencies = {
  opener: Pick<ProjectDocumentLiveOpener, "resolveIdentity" | "replaceTransfer">;
  openRoute: OpenContextRoute | null;
  captureNavigation?: () => () => boolean;
  openTrash(documentId: string): Promise<unknown>;
  resources?: Pick<
    import("@/core/resources/account-resource-replica").AccountResourceReplica,
    "accountId" | "observeProjection" | "readProjectionState"
  > | null;
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
  | { kind: "applied" }
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
      trashed,
      refreshIdentity,
      known,
      workId,
      focus,
      replace,
      beside,
      signal,
    }: OpenProjectDocumentRequest,
  ): Promise<OpenDocumentOutcome> {
    const navigationIsCurrent = this.dependencies.captureNavigation?.();
    const token = ++this.attempt;
    const controller = new AbortController();
    this.pending.add(controller);
    this.current?.abort();
    this.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const canCommit = () => !controller.signal.aborted && token === this.attempt;
    const isCurrent = () => canCommit() && navigationIsCurrent?.() !== false;

    try {
      if (trashed) {
        const resolution = await this.dependencies.opener.resolveIdentity(projectId, documentId);
        if (!isCurrent()) return { kind: "cancelled" };
        if (resolution.kind === "deleted")
          return this.openTrash(documentId, controller.signal, isCurrent);
        return {
          kind: "refused",
          reason:
            resolution.kind === "failed" || resolution.kind === "malformed"
              ? "lookup-failed"
              : "gone",
        };
      }
      const identified = await this.identify(projectId, {
        documentId,
        refreshIdentity,
        known,
        workId,
        isCurrent,
      });
      if (identified.kind === "cancelled") return identified;
      if (identified.kind === "refused") return identified;
      if (identified.kind === "trashed")
        return this.openTrash(documentId, controller.signal, isCurrent);
      const { identity, transfer } = identified;

      if (refreshIdentity && this.dependencies.resources) {
        // Restoring a deleted ancestor republishes the document through the catalog. Do not
        // open it while the replica still holds the prior terminal record: that record would
        // immediately read as its removal.
        try {
          await waitForLivingProjection(
            this.dependencies.resources,
            projectId,
            documentId,
            controller.signal,
          );
        } catch {
          return controller.signal.aborted
            ? { kind: "cancelled" }
            : { kind: "refused", reason: "lookup-failed" };
        }
        if (!isCurrent()) return { kind: "cancelled" };
      }

      if (!this.dependencies.openRoute)
        throw new Error("Opening a project document requires the project route owner");
      const committed = await this.commitFile({
        projectId,
        scheme: identity.scheme,
        file: identity.file,
        workId: identity.workId ?? workId,
        rootThreadId: identity.rootThreadId,
        chatId: identity.chatId,
        focus,
        replace,
        beside,
        isCurrent,
        canCommit,
        transfer,
      });
      if (committed.kind === "failed") return { kind: "refused", reason: "lookup-failed" };
      if (committed.kind === "no-viewer") return { kind: "refused", reason: "no-viewer" };
      return committed.kind === "applied"
        ? { kind: "committed", documentId }
        : { kind: "cancelled" };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
      if (this.current === controller) this.current = null;
    }
  }

  /**
   * Where a document lives now: the caller's known row, the replica's record, or one lookup.
   * A lookup's answer rides along as the transfer the host's session takes.
   */
  private async identify(
    projectId: string,
    {
      documentId,
      refreshIdentity,
      known,
      workId,
      isCurrent,
    }: Pick<OpenProjectDocumentRequest, "documentId" | "refreshIdentity" | "known" | "workId"> & {
      isCurrent: () => boolean;
    },
  ): Promise<
    | { kind: "identified"; identity: KnownDocumentIdentity; transfer?: AvailableOpenResolution }
    | { kind: "trashed" }
    | { kind: "cancelled" }
    | { kind: "refused"; reason: "gone" | "lookup-failed" }
  > {
    const projection = this.dependencies.resources?.readProjectionState(projectId);
    const record =
      projection?.kind === "ready"
        ? projection.snapshot.records.find(
            (candidate) => candidate.resource.identity.documentId === documentId,
          )
        : undefined;
    if (!refreshIdentity && record?.resource.lifecycle.kind === "terminal")
      return { kind: "trashed" };

    let identity = refreshIdentity ? undefined : known;
    if (!refreshIdentity && !identity && projection?.kind === "ready" && record) {
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
      if (resolution.kind === "deleted") return { kind: "trashed" };
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
        chatId: resolution.entry.scope.kind === "chat" ? resolution.entry.scope.chatId : undefined,
      };
    }
    return { kind: "identified", identity, ...(transfer ? { transfer } : {}) };
  }

  /**
   * The descriptor a view paints a document from, resolved like an open but navigating nowhere:
   * the side's document. Null when the document no longer opens in the editor (removed, or an
   * upload); throws when the lookup failed.
   */
  async describe(
    projectId: string,
    documentId: string,
    workId?: string,
  ): Promise<ContextTab | null> {
    const identified = await this.identify(projectId, {
      documentId,
      workId,
      isCurrent: () => true,
    });
    if (identified.kind === "refused" && identified.reason === "lookup-failed")
      throw new Error("Couldn't look up the document");
    if (identified.kind !== "identified") return null;
    const { identity, transfer } = identified;
    if (!isEditorScheme(identity.scheme)) return null;
    this.dependencies.opener.replaceTransfer(documentId, transfer);
    return contextTabFromFile(
      identity.scheme,
      identity.file,
      identity.rootThreadId
        ? { rootThreadId: identity.rootThreadId }
        : { workId: identity.workId ?? workId ?? null },
    );
  }

  private async openTrash(
    documentId: string,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<OpenDocumentOutcome> {
    if (signal.aborted) return { kind: "cancelled" };
    if (!isCurrent()) return { kind: "cancelled" };
    await this.dependencies.openTrash(documentId);
    return { kind: "trashed", documentId };
  }

  private async commitFile(input: {
    projectId: string;
    scheme: ProjectContextTreeScheme;
    file: CatalogFile;
    workId: string | undefined;
    rootThreadId?: string;
    chatId?: string;
    focus?: true;
    replace?: true;
    beside?: BesideHint;
    isCurrent: () => boolean;
    canCommit: () => boolean;
    transfer?: AvailableOpenResolution;
  }): Promise<CommitResult> {
    if (!input.isCurrent()) return { kind: "cancelled" };
    // An upload belongs to its chat and has no Editor address.
    if (!isEditorScheme(input.scheme)) {
      this.current = null;
      return { kind: "no-viewer" };
    }
    const owner: ContextOwner = input.rootThreadId
      ? { rootThreadId: input.rootThreadId }
      : { workId: input.workId ?? null };
    const tab = contextTabFromFile(input.scheme, input.file, owner);
    const openRoute = this.dependencies.openRoute;
    if (!openRoute) throw new Error("Opening a project document requires the project route owner");
    this.current = null;
    const settlement = await openRoute(
      contextRouteRequest({
        scheme: input.scheme,
        path: input.file.path,
        workId: input.workId,
        rootThreadId: input.rootThreadId,
        documentId: input.file.documentId,
      }),
      {
        tab,
        ...(input.focus ? { focus: true as const } : {}),
        ...(input.replace ? { replace: true } : {}),
        ...(input.beside ? { beside: input.beside } : {}),
        isCurrent: input.isCurrent,
        canCommit: input.canCommit,
        afterCommit: () =>
          this.dependencies.opener.replaceTransfer(input.file.documentId, input.transfer),
      },
    );
    return settlement.kind === "failed"
      ? { kind: "failed" }
      : settlement.kind === "applied"
        ? { kind: "applied" }
        : { kind: "cancelled" };
  }
}

function waitForLivingProjection(
  resources: NonNullable<NavigationAdapterDependencies["resources"]>,
  projectId: string,
  documentId: string,
  signal: AbortSignal,
): Promise<void> {
  const living = (snapshot: ResourceProjectionSnapshot) =>
    snapshot.records.some(
      (record) =>
        record.resource.identity.documentId === documentId &&
        record.resource.lifecycle.kind !== "terminal",
    );
  const state = resources.readProjectionState(projectId);
  if (state.kind === "ready" && living(state.snapshot)) return Promise.resolve();
  if (state.kind === "failed") return Promise.reject(state.error);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let stop: () => void = () => undefined;
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", abort);
      stop();
      settle();
    };
    const abort = () => finish(() => reject(signal.reason));
    stop = resources.observeProjection(
      projectId,
      (snapshot) => {
        if (living(snapshot)) finish(resolve);
      },
      (error) => finish(() => reject(error)),
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
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
  const { navigate: openTrash } = useProjectTrashNavigation();
  const opener = useProjectDocumentLiveOpener();
  const resources = useOptionalAccountResourceReplica();
  const presented = useOptionalPresentedDocuments();
  const openContextRoute = useOpenContextRoute();
  useEffect(() => {
    if (!resources) return;
    return resources.observeProjection(
      projectId,
      () => undefined,
      () => undefined,
    );
  }, [projectId, resources]);
  // A transfer is taken by the host that mounts its document; one whose document no view
  // presents is let go. Checked after the commit that ended a presentation, whose own new host
  // presents in the same commit.
  useEffect(() => {
    if (!presented) return;
    let live = true;
    const prune = () =>
      queueMicrotask(() => {
        if (live)
          opener.pruneTransfers(
            new Set(presented.documents(projectId).map((tab) => tab.documentId)),
          );
      });
    const stop = presented.subscribe(prune);
    return () => {
      live = false;
      stop();
    };
  }, [opener, presented, projectId]);
  const owner = useMemo<ProjectDocumentNavigationOwner>(
    () => ({
      projectId,
      adapter: new ProjectDocumentNavigationAdapter({
        opener,
        openRoute: openContextRoute,
        captureNavigation,
        openTrash,
        resources,
      }),
    }),
    [openContextRoute, openTrash, opener, projectId, captureNavigation, resources],
  );
  useEffect(() => () => owner.adapter.dispose(), [owner]);

  return createElement(ProjectDocumentNavigationContext.Provider, { value: owner }, children);
}

export function useOpenProjectDocument(projectId: string | undefined): OpenProjectDocument {
  const owner = useContext(ProjectDocumentNavigationContext);
  const beside = useOpenedFromChat();

  return useCallback(
    async (request) => {
      if (!projectId || owner?.projectId !== projectId)
        return { kind: "refused", reason: "lookup-failed" };
      return owner.adapter.open(projectId, beside ? { beside, ...request } : request);
    },
    [owner, projectId, beside],
  );
}

/** Whether a chat's reference opens in main: an upload belongs to its chat and has no Editor address. */
export function canOpenReference(uri: string): boolean {
  return !uri.startsWith("uploads://");
}

/** Resolves a document's descriptor without opening it (`describe`). */
export function useDescribeProjectDocument(
  projectId: string,
): (documentId: string, workId?: string) => Promise<ContextTab | null> {
  const owner = useContext(ProjectDocumentNavigationContext);
  return useCallback(
    async (documentId, workId) =>
      owner?.projectId === projectId ? owner.adapter.describe(projectId, documentId, workId) : null,
    [owner, projectId],
  );
}

/** Current project-route identity for authorization-only projections. */
export function useProjectDocumentNavigationProjectId(): string | null {
  return useContext(ProjectDocumentNavigationContext)?.projectId ?? null;
}
