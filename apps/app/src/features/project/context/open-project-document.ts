import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { DocumentSession } from "@/core/editor/document-session";
import type {
  LiveDocumentSessionLease,
  LiveDocumentSessionRegistry,
} from "@/core/editor/document-session-registry";
import { contextRouteRequest } from "../routing/project-route";
import type { ProjectStandings } from "./project-standings";
/**
 * Opening a project document by id — the app's one answer to "take me there".
 *
 * Doors that already render a tree row carry its identity; id-only doors read it from the replay
 * of the project's list, waiting for the list only while it has not been read. Both commit main's
 * address before the destination acquires its live session. Every door opens the document in main.
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
  useRef,
  useState,
} from "react";
import { ownerOfSource, useProjectTrees } from "@/client/query/useProjectTrees";
import { isEditorScheme, type OpenDocument } from "@/client/stores";
import type { TreeFile } from "@/core/project-tree/tree-view";
import {
  type OpenContextRoute,
  useOpenContextRoute,
  useTrashNavigation,
} from "../routing/ProjectNavigationContext";
import { useProjectStandings } from "./account-feature-context";
import { openDocumentFromFile } from "./open-document-from-file";
import { UploadViewerDialog } from "./UploadViewerDialog";

export interface LiveDocumentBinding {
  readonly projectId: ProjectId;
  readonly documentId: DocumentId;
  readonly session: DocumentSession;
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
  /** Also admits a document in Trash: its Trash view shows the text the session holds. */
  trashed?: true;
  signal?: AbortSignal;
};

/** Admits a document's live session once the list shows it in the tree. */
export class ProjectDocumentLiveOpener {
  constructor(
    private readonly dependencies: {
      registry: Pick<
        LiveDocumentSessionRegistry,
        "admit" | "retain" | "get" | "release" | "restartUnavailableRoom"
      >;
      standings: Pick<ProjectStandings, "standing" | "whenReadable">;
      epochSignal: AbortSignal;
    },
  ) {}

  /**
   * Admits the document the project's list has in its tree. The list says whether it is there, so
   * a document made here opens at once, before the server has heard of it: its session paints
   * from the local copy and its room connects when the server has the create.
   */
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
        return { kind: "unavailable", reason: "not-visible" };
      case "in-tree":
        if (standing.node.kind !== "document") return { kind: "not-editable" };
    }
    try {
      return {
        kind: "opened",
        admission: this.capability(this.dependencies.registry.admit(projectId, documentId)),
      };
    } catch {
      return cancelled() ? { kind: "cancelled" } : { kind: "unavailable", reason: "failed" };
    }
  }

  private capability(lease: LiveDocumentSessionLease): AdmittedLiveDocument {
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
  file: TreeFile;
};

export type OpenProjectDocumentRequest = {
  documentId: string;
  known?: KnownDocumentIdentity;
  /** Omitted keeps the current Editor Work; Work-scoped files always use their resolved owner row. */
  workId?: string;
  focus?: true;
  /** Takes the place of the current history entry (main leaving a document the writer removed). */
  replace?: true;
  signal?: AbortSignal;
};

export type OpenDocumentOutcome =
  | { kind: "committed"; documentId: string }
  | { kind: "trashed"; documentId: string }
  | { kind: "cancelled" }
  | { kind: "refused"; reason: "gone" | "lookup-failed" };
export type OpenProjectDocument = (
  request: OpenProjectDocumentRequest,
) => Promise<OpenDocumentOutcome>;

type NavigationAdapterDependencies = {
  standings: Pick<ProjectStandings, "standing" | "whenReadable">;
  openRoute: OpenContextRoute | null;
  captureNavigation?: () => () => boolean;
  openTrash(documentId: string, options: { replace?: boolean }): Promise<unknown>;
  /** Where the replay of the list shows a document, or null while it shows none. */
  locate(documentId: string): KnownDocumentIdentity | null;
  /** Shows a chat's upload, which belongs to no main address, in its viewer. */
  viewUpload(tab: Extract<OpenDocument, { kind: "viewer" }>): void;
};

type CommitResult = { kind: "applied" } | { kind: "cancelled" } | { kind: "failed" };

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
    { documentId, known, workId, focus, replace, signal }: OpenProjectDocumentRequest,
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
        const tab = openDocumentFromFile(
          identity.scheme,
          identity.file,
          identity.chatId ? { chatThreadId: identity.chatId } : {},
        );
        if (tab.kind !== "viewer") return { kind: "refused", reason: "lookup-failed" };
        if (!isCurrent()) return { kind: "cancelled" };
        this.dependencies.viewUpload(tab);
        return { kind: "committed", documentId };
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
        isCurrent,
        canCommit,
      });
      if (committed.kind === "failed") return { kind: "refused", reason: "lookup-failed" };
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
   * Where a document lives now: the caller's known row, or the replay of the list, which is
   * waited for only while the list has not been read.
   */
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
    const located = this.dependencies.locate(documentId);
    if (located) return { kind: "identified", identity: located };
    switch (standings.standing(projectId, documentId).kind) {
      case "in-trash":
        return { kind: "trashed" };
      case "in-tree":
        // The list shows it but its source has not come yet.
        return { kind: "refused", reason: "lookup-failed" };
      default:
        return { kind: "refused", reason: "gone" };
    }
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
    chatId?: string;
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
  const { open: openTrash } = useTrashNavigation();
  const standings = useProjectStandings();
  const trees = useProjectTrees(projectId);
  // Read at each open, so a change of the list does not make a new adapter.
  const treesRef = useRef(trees);
  treesRef.current = trees;
  const openContextRoute = useOpenContextRoute();
  const [upload, setUpload] = useState<Extract<OpenDocument, { kind: "viewer" }> | null>(null);
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
        viewUpload: setUpload,
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

/** Resolves a document's descriptor without opening it (`describe`). */
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

/** Current project-route identity for authorization-only projections. */
export function useProjectDocumentNavigationProjectId(): string | null {
  return useContext(ProjectDocumentNavigationContext)?.projectId ?? null;
}
