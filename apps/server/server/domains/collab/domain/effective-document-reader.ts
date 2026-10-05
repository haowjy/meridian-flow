/** Effective branch reads with staged-response overlays and manifest projection. */
import {
  type AgentEditCodec,
  type DocHandle,
  type DocumentCoordinator,
  toDocHandle,
  unwrapDoc,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import { Ok, type Result } from "../../../shared/result.js";
import type { BranchPeerShadowAccess, SyncError } from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchPullService } from "./branch-pulls.js";
import { BranchNotFoundError } from "./branch-resolver.js";
import { documentRevision, versioned } from "./document-revision.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
  destination: "live" | "draft";
};

export function createEffectiveDocumentReader(input: {
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchPulls: BranchPullService;
  liveCoordinator: DocumentCoordinator;
  agentEdit: ThreadPeerAgentEditCore;
  documents: Pick<MarkdownDocumentEngine, "readVersionedMarkdown" | "serializeVersionedDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): BranchPeerShadowAccess {
  /**
   * Whether this reply's staged writes to the document belong to the version
   * being read. A reply that drafted a document must not show those writes in
   * a live read, and the reverse.
   */
  function stagedInVersion(command: EffectiveReadInput): command is EffectiveReadInput & {
    responseId: string;
  } {
    if (!command.responseId) return false;
    const staged = input.agentEdit.responseDestination(command.responseId, command.documentId);
    return staged === undefined || staged.kind === command.destination;
  }

  function readWithStagedResponseOverlay<T>(
    doc: Y.Doc,
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> {
    if (!stagedInVersion(command)) return read(toDocHandle(doc));
    return input.agentEdit
      .withResponseDocument(command.responseId, command.documentId, toDocHandle(doc), read)
      .then((staged) => staged ?? read(toDocHandle(doc)));
  }

  function readStagedResponseOnly<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> | null {
    if (!stagedInVersion(command)) return null;
    if (!input.agentEdit.hasResponseDocument(command.responseId, command.documentId)) return null;
    return input.agentEdit
      .withResponseDocument(command.responseId, command.documentId, null, read)
      .then((result) => {
        if (result === null) {
          throw new Error(`Staged response document disappeared: ${command.documentId}`);
        }
        return result;
      });
  }

  async function readEffective<T, E>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
    fallback: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> {
    const isStagedOnlyCreatedDocument = Boolean(
      command.responseId &&
        input.agentEdit
          .responseDocuments(command.responseId, command.threadId ?? undefined)
          .created.includes(command.documentId),
    );
    if (isStagedOnlyCreatedDocument) {
      const stagedOnly = readStagedResponseOnly(command, read);
      if (stagedOnly !== null) return Ok(await stagedOnly);
    }
    if (command.destination === "live") {
      // Live reads ignore any Work draft, kept or not (D40), but still see this
      // reply's own staged writes.
      if (
        stagedInVersion(command) &&
        input.agentEdit.hasResponseDocument(command.responseId, command.documentId)
      ) {
        return Ok(
          await input.liveCoordinator.withDocument(command.documentId, (doc) =>
            readWithStagedResponseOverlay(doc, command, read),
          ),
        );
      }
      return fallback();
    }
    if (command.threadId) {
      try {
        const existingPeer = await input.branches.resolveThreadBranch(
          command.documentId,
          command.threadId,
        );
        existingPeer.doc.destroy();
        await input.branchPulls.pullThreadPeer({
          documentId: command.documentId,
          threadId: command.threadId,
        });
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      try {
        const branch = await input.branches.resolveThreadBranch(
          command.documentId,
          command.threadId,
        );
        return Ok(await readEffectiveBranch(branch, command, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      await input.branchPulls.flushLivePull(command.documentId);
      try {
        const workDraft = await input.branches.resolveWorkDraftBranchForThread(
          command.documentId,
          command.threadId,
        );
        return Ok(await readEffectiveBranch(workDraft, command, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      const stagedOnly = readStagedResponseOnly(command, read);
      if (stagedOnly !== null) return Ok(await stagedOnly);
    }
    return fallback();
  }

  async function readEffectiveBranch<T>(
    branch: { branchId: string; doc: Y.Doc },
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return input.branchCoordinator.readBranch(branch.branchId, async (doc) =>
        readWithStagedResponseOverlay(doc, command, read),
      );
    } finally {
      branch.doc.destroy();
    }
  }

  return {
    async readEffectiveRevision(command) {
      try {
        const result = await readEffective(
          command,
          async (doc) => documentRevision(unwrapDoc(doc)),
          () =>
            input.liveCoordinator.withDocument(command.documentId, async (doc) =>
              Ok(documentRevision(doc)),
            ),
        );
        return result.ok ? result.value : null;
      } catch {
        return null;
      }
    },
    pullThreadPeer(command) {
      return input.branchPulls.pullThreadPeer(command);
    },
    flushBranchLivePull(documentId) {
      return input.branchPulls.flushLivePull(documentId);
    },
    readEffectiveMarkdown(command) {
      return readEffective(
        command,
        (doc) => input.documents.serializeVersionedDocument(command.documentId, unwrapDoc(doc)),
        () => input.documents.readVersionedMarkdown(command.documentId),
      ) as Promise<Result<{ content: string; revision: string | null }, SyncError>>;
    },
    readEffectiveHashlines(command) {
      return readEffective(
        command,
        async (doc) =>
          versioned(unwrapDoc(doc), (doc) =>
            input.model.serializeBlockLines(toDocHandle(doc), input.codec),
          ),
        () =>
          input.liveCoordinator.withDocument(command.documentId, async (doc) =>
            Ok(
              versioned(doc, (doc) =>
                input.model.serializeBlockLines(toDocHandle(doc), input.codec),
              ),
            ),
          ),
      ) as Promise<Result<{ content: string[]; revision: string | null }, SyncError>>;
    },
    async resolveManifestMembership(command) {
      if (command.threadId || command.workId) {
        const manifest = await input.branches.ensureProjectManifest({
          projectId: command.projectId,
        });
        try {
          if (command.threadId) {
            await input.branchPulls.pullThreadPeer({
              documentId: manifest.documentId,
              threadId: command.threadId,
            });
          } else if (command.workId) {
            await input.branchPulls.flushLivePull(manifest.documentId);
          }
        } finally {
          manifest.doc.destroy();
        }
      }
      const membership = await input.branches.resolveManifestMembership(command);
      if (!command.responseId || !command.threadId) return membership;
      return {
        ...membership,
        members: [
          ...new Set([
            ...membership.members,
            ...input.agentEdit.responseDocuments(command.responseId, command.threadId).created,
          ]),
        ],
      };
    },
    reconcileProjectManifest(projectId: ProjectId) {
      return input.branches.reconcileProjectManifest(projectId);
    },
    async recordManifestDocumentCreated(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ) {
      await input.branches.recordManifestDocumentCreated(documentId, view);
    },
    async recordManifestDocumentDeleted(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ) {
      await input.branches.recordManifestDocumentDeleted(documentId, view);
    },
  };
}
