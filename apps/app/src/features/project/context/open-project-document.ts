import { t } from "@lingui/core/macro";
import {
  type ContextOwner,
  isProjectContextTreeScheme,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import { isEditorScheme, type OpenDocument, type ServerOpenDocument } from "@/client/stores";
import { notifyFailure } from "@/components/app/failure-toast";
import { type DocumentSession, sessionRoomKey } from "@/core/editor/document-session";
import type {
  DocumentSessionLease,
  LiveDocumentSessionRegistry,
} from "@/core/editor/document-session-registry";
import type { TreeFile } from "@/core/project-tree/tree-view";
import {
  type OpenContextRoute,
  useOpenContextRoute,
  useTrashNavigation,
} from "../routing/ProjectNavigationContext";
import { contextRouteRequest } from "../routing/project-route";
import { useProjectStandings } from "./account-feature-context";
import { openDocumentFromFile } from "./open-document-from-file";
import type { ProjectStandings } from "./project-standings";
import { UploadViewerDialog } from "./UploadViewerDialog";

export interface LiveDocumentBinding {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  readonly session: DocumentSession;
  subscribeSession(listener: (session: DocumentSession) => void): () => void;
  readonly local?: true;
  release(): void;
}

export interface AdmittedLiveDocument {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  bind(ownerId: string): Promise<LiveDocumentBinding>;
}

export type ProjectDocumentLiveOpenResult =
  | { kind: "opened"; admission: AdmittedLiveDocument }
  | { kind: "cancelled" }
  | { kind: "not-editable" }
  | {
      kind: "unavailable";
      reason: "deleted" | "authority-unavailable" | "not-visible" | "indeterminate" | "failed";
    };

export type ProjectDocumentLiveOpenRequest = {
  projectId: ProjectId;
  documentId: DocumentId;
  trashed?: true;
  workOnly?: true;
  draftId?: string;
  signal?: AbortSignal;
};

export class ProjectDocumentLiveOpener {
  constructor(
    private readonly dependencies: {
      registry: Pick<
        LiveDocumentSessionRegistry,
        "admit" | "retain" | "get" | "release" | "restartUnavailableRoom" | "observeReplacement"
      >;
      standings: Pick<ProjectStandings, "standing" | "whenReadable">;
      epochSignal: AbortSignal;
    },
  ) {}

  async open(input: ProjectDocumentLiveOpenRequest): Promise<ProjectDocumentLiveOpenResult> {
    const { projectId, documentId, signal } = input;
    const cancelled = () => signal?.aborted || this.dependencies.epochSignal.aborted;
    if (cancelled()) return { kind: "cancelled" };
    let standing = this.dependencies.standings.standing(projectId, documentId);
    if (standing.kind === "waiting") {
      try {
        await this.dependencies.standings.whenReadable(projectId, signal);
      } catch {
        return cancelled() ? { kind: "cancelled" } : { kind: "unavailable", reason: "failed" };
      }
      standing = this.dependencies.standings.standing(projectId, documentId);
    }
    if (cancelled()) return { kind: "cancelled" };
    switch (standing.kind) {
      case "purged":
        return { kind: "unavailable", reason: "deleted" };
      case "in-trash":
        if (!input.trashed) return { kind: "unavailable", reason: "deleted" };
        if (standing.node.kind !== "document") return { kind: "not-editable" };
        break;
      case "not-in-list":
      case "waiting":
        if (input.workOnly) break;
        return { kind: "unavailable", reason: "not-visible" };
      case "in-tree":
        if (standing.node.kind !== "document") return { kind: "not-editable" };
    }
    try {
      return {
        kind: "opened",
        admission: this.capability(
          this.dependencies.registry.admit(projectId, documentId, input.draftId),
        ),
      };
    } catch {
      return cancelled() ? { kind: "cancelled" } : { kind: "unavailable", reason: "failed" };
    }
  }

  private capability(lease: DocumentSessionLease): AdmittedLiveDocument {
    const registry = this.dependencies.registry;
    return Object.freeze({
      projectId: lease.projectId,
      documentId: lease.documentId,
      async bind(ownerId: string): Promise<LiveDocumentBinding> {
        registry.retain(ownerId, [lease]);
        try {
          let session = registry.get(lease);
          const snapshot = session.getSnapshot();
          if (
            snapshot.status === "access-lost" ||
            snapshot.connectionState?.kind === "terminal" ||
            session.resetDisposition === "removed"
          ) {
            await registry.restartUnavailableRoom(lease);
            session = registry.get(lease);
          }
          let released = false;
          const listeners = new Set<(session: DocumentSession) => void>();
          const stopObserving = registry.observeReplacement(
            sessionRoomKey(lease.room),
            (replacement) => {
              session = replacement;
              for (const listener of [...listeners]) listener(replacement);
            },
          );
          return Object.freeze({
            projectId: lease.projectId,
            documentId: lease.documentId,
            get session() {
              return session;
            },
            subscribeSession(listener: (session: DocumentSession) => void) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            release() {
              if (released) return;
              released = true;
              stopObserving();
              listeners.clear();
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

export type KnownDocumentIdentity = ContextOwner & {
  scheme: ProjectContextTreeScheme;
  file: TreeFile;
};

export type OpenProjectDocumentRequest = {
  documentId: string;
  known?: KnownDocumentIdentity;
  workId?: string;
  focus?: true;
  replace?: true;
  placeBeside?: () => boolean;
  fallsBack?: true;
  signal?: AbortSignal;
};

export type OpenDocumentOutcome =
  | { kind: "committed"; documentId: string }
  | { kind: "trashed"; documentId: string }
  | { kind: "cancelled" }
  | { kind: "refused"; reason: "gone" | "lookup-failed"; name?: string };
export type OpenProjectDocument = (
  request: OpenProjectDocumentRequest,
) => Promise<OpenDocumentOutcome>;

type NavigationAdapterDependencies = {
  standings: Pick<ProjectStandings, "standing" | "whenReadable">;
  openRoute: OpenContextRoute | null;
  captureNavigation?: () => () => boolean;
  openTrash(documentId: string, options: { replace?: boolean }): Promise<unknown>;
  locate(documentId: string): KnownDocumentIdentity | null;
  whenLocatable(signal: AbortSignal): Promise<void>;
  viewUpload(tab: ServerOpenDocument): void;
  refused(outcome: Extract<OpenDocumentOutcome, { kind: "refused" }>, retry: () => void): void;
};

type CommitResult = { kind: "applied" } | { kind: "cancelled" } | { kind: "failed" };

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

  async open(projectId: string, request: OpenProjectDocumentRequest): Promise<OpenDocumentOutcome> {
    let outcome: OpenDocumentOutcome;
    try {
      outcome = await this.run(projectId, request);
    } catch (error) {
      // A door drops the promise: an open that threw would otherwise end in silence.
      reportError(error);
      outcome = { kind: "refused", reason: "lookup-failed" };
    }
    if (outcome.kind === "refused" && !request.fallsBack)
      // A later Retry is a new open: replacing would drop whatever page the writer is on by then.
      this.dependencies.refused(outcome, () => {
        void this.open(projectId, { ...request, replace: undefined, signal: undefined });
      });
    return outcome;
  }

  private async run(
    projectId: string,
    { documentId, known, workId, focus, replace, placeBeside, signal }: OpenProjectDocumentRequest,
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
      const identified = await this.identify(projectId, {
        documentId,
        known,
        signal: controller.signal,
        isCurrent,
      });
      if (identified.kind === "cancelled") return identified;
      if (identified.kind === "refused") return identified;
      if (identified.kind === "trashed")
        return this.openTrash(documentId, controller.signal, isCurrent, replace);
      const { identity } = identified;

      if (!isEditorScheme(identity.scheme)) {
        if (!isCurrent()) return { kind: "cancelled" };
        this.dependencies.viewUpload(
          openDocumentFromFile(identity.scheme, identity.file, identity),
        );
        return { kind: "committed", documentId };
      }

      if (!isCurrent()) return { kind: "cancelled" };
      if (placeBeside?.()) return { kind: "committed", documentId };
      if (!this.dependencies.openRoute)
        throw new Error("Opening a project document requires the project route owner");
      const committed = await this.commitFile({
        projectId,
        scheme: identity.scheme,
        file: identity.file,
        workId: identity.workId ?? workId,
        rootThreadId: identity.rootThreadId,
        focus,
        replace,
        isCurrent,
        canCommit,
      });
      if (committed.kind === "failed")
        return { kind: "refused", reason: "lookup-failed", name: identity.file.name };
      return committed.kind === "applied"
        ? { kind: "committed", documentId }
        : { kind: "cancelled" };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(controller);
      if (this.current === controller) this.current = null;
    }
  }

  private async identify(
    projectId: string,
    {
      documentId,
      known,
      signal,
      isCurrent,
    }: Pick<OpenProjectDocumentRequest, "documentId" | "known"> & {
      signal: AbortSignal;
      isCurrent: () => boolean;
    },
  ): Promise<
    | { kind: "identified"; identity: KnownDocumentIdentity }
    | { kind: "trashed" }
    | { kind: "cancelled" }
    | { kind: "refused"; reason: "gone" | "lookup-failed" }
  > {
    const { standings } = this.dependencies;
    // The list's own answer first: a row the caller carries, or the views' last render, can
    // predate a delete.
    if (standings.standing(projectId, documentId).kind === "in-trash") return { kind: "trashed" };
    const placed = known ?? this.dependencies.locate(documentId);
    if (placed) return { kind: "identified", identity: placed };
    if (standings.standing(projectId, documentId).kind === "waiting") {
      try {
        await standings.whenReadable(projectId, signal);
      } catch {
        return isCurrent() ? { kind: "refused", reason: "lookup-failed" } : { kind: "cancelled" };
      }
      if (!isCurrent()) return { kind: "cancelled" };
    }
    let located = this.dependencies.locate(documentId);
    if (!located && standings.standing(projectId, documentId).kind === "in-tree") {
      try {
        await this.dependencies.whenLocatable(signal);
      } catch {
        return isCurrent() ? { kind: "refused", reason: "lookup-failed" } : { kind: "cancelled" };
      }
      if (!isCurrent()) return { kind: "cancelled" };
      located = this.dependencies.locate(documentId);
    }
    if (located) return { kind: "identified", identity: located };
    switch (standings.standing(projectId, documentId).kind) {
      case "in-trash":
        return { kind: "trashed" };
      case "in-tree":
        return { kind: "refused", reason: "lookup-failed" };
      default:
        return { kind: "refused", reason: "gone" };
    }
  }

  async describe(
    projectId: string,
    documentId: string,
    workId?: string,
  ): Promise<OpenDocument | null> {
    const identified = await this.identify(projectId, {
      documentId,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    if (identified.kind === "refused" && identified.reason === "lookup-failed")
      throw new Error("Couldn't read the document's place");
    if (identified.kind !== "identified") return null;
    const { identity } = identified;
    if (!isEditorScheme(identity.scheme)) return null;
    return openDocumentFromFile(
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
    replace: true | undefined,
  ): Promise<OpenDocumentOutcome> {
    if (signal.aborted) return { kind: "cancelled" };
    if (!isCurrent()) return { kind: "cancelled" };
    await this.dependencies.openTrash(documentId, { replace });
    return { kind: "trashed", documentId };
  }

  private async commitFile(input: {
    projectId: string;
    scheme: ProjectContextTreeScheme;
    file: TreeFile;
    workId: string | undefined;
    rootThreadId?: string;
    focus?: true;
    replace?: true;
    isCurrent: () => boolean;
    canCommit: () => boolean;
  }): Promise<CommitResult> {
    if (!input.isCurrent()) return { kind: "cancelled" };
    const owner: ContextOwner = input.rootThreadId
      ? { rootThreadId: input.rootThreadId }
      : { workId: input.workId ?? null };
    const tab = openDocumentFromFile(input.scheme, input.file, owner);
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
        document: tab,
        ...(input.focus ? { focus: true as const } : {}),
        ...(input.replace ? { replace: true } : {}),
        isCurrent: input.isCurrent,
        canCommit: input.canCommit,
      },
    );
    return settlement.kind === "failed"
      ? { kind: "failed" }
      : settlement.kind === "applied"
        ? { kind: "applied" }
        : { kind: "cancelled" };
  }
}

type ProjectDocumentNavigationOwner = {
  projectId: string;
  adapter: ProjectDocumentNavigationAdapter;
};

const ProjectDocumentNavigationContext = createContext<ProjectDocumentNavigationOwner | null>(null);

export function ProjectDocumentNavigationProvider({
  projectId,
  children,
  captureNavigation,
}: {
  projectId: string;
  children: ReactNode;
  captureNavigation?: () => () => boolean;
}) {
  const { open: openTrash } = useTrashNavigation();
  const standings = useProjectStandings();
  const trees = useProjectTrees(projectId);
  // Read at each open, so a change of the list does not make a new adapter.
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const locatable = useRef(new Set<() => void>());
  useEffect(() => {
    if (!trees.ready) return;
    const waiting = [...locatable.current];
    locatable.current.clear();
    for (const resolve of waiting) resolve();
  }, [trees]);
  const openContextRoute = useOpenContextRoute();
  const [upload, setUpload] = useState<ServerOpenDocument | null>(null);
  const owner = useMemo<ProjectDocumentNavigationOwner>(
    () => ({
      projectId,
      adapter: new ProjectDocumentNavigationAdapter({
        standings,
        openRoute: openContextRoute,
        captureNavigation,
        openTrash,
        locate: (documentId) => {
          const place = treesRef.current.find(documentId);
          if (!place || !isProjectContextTreeScheme(place.source.scheme)) return null;
          return { scheme: place.source.scheme, file: place.file, ...ownerOfSource(place.source) };
        },
        whenLocatable: (signal) =>
          new Promise<void>((resolve, reject) => {
            if (treesRef.current.ready) return resolve();
            const abort = () => {
              locatable.current.delete(located);
              reject(signal.reason);
            };
            const located = () => {
              signal.removeEventListener("abort", abort);
              resolve();
            };
            if (signal.aborted) return reject(signal.reason);
            locatable.current.add(located);
            signal.addEventListener("abort", abort, { once: true });
          }),
        viewUpload: setUpload,
        refused: (outcome, retry) =>
          notifyFailure({
            key: `open-document:${projectId}`,
            title: t`Couldn't open`,
            detail: outcome,
            ...(outcome.reason === "lookup-failed"
              ? { action: { label: t`Retry`, run: retry } }
              : {}),
          }),
      }),
    }),
    [openContextRoute, openTrash, standings, projectId, captureNavigation],
  );
  useEffect(() => () => owner.adapter.dispose(), [owner]);

  return createElement(
    ProjectDocumentNavigationContext.Provider,
    { value: owner },
    children,
    createElement(UploadViewerDialog, {
      projectId,
      document: upload,
      onClose: () => setUpload(null),
    }),
  );
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

export function useDescribeProjectDocument(
  projectId: string,
): (documentId: string, workId?: string) => Promise<OpenDocument | null> {
  const owner = useContext(ProjectDocumentNavigationContext);
  return useCallback(
    async (documentId, workId) =>
      owner?.projectId === projectId ? owner.adapter.describe(projectId, documentId, workId) : null,
    [owner, projectId],
  );
}

export function useProjectDocumentNavigationProjectId(): string | null {
  return useContext(ProjectDocumentNavigationContext)?.projectId ?? null;
}
