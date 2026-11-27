import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type { ProjectStandings } from "@/core/tree-list/project-standings";
import { type DocumentSession, sessionRoomKey } from "./document-session";
import type {
  DocumentSessionLease,
  LiveDocumentSessionRegistry,
} from "./document-session-registry";

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
