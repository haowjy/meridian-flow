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
import type { AutoBranchPushPort } from "./branch-push-contracts.js";
import { BranchNotFoundError } from "./branch-resolver.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
};

export function createEffectiveDocumentReader(input: {
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchPulls: BranchPullService;
  branchPush: AutoBranchPushPort;
  liveCoordinator: DocumentCoordinator;
  agentEdit: ThreadPeerAgentEditCore;
  documents: Pick<MarkdownDocumentEngine, "readAsMarkdown" | "serializeDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodec;
}): BranchPeerShadowAccess {
  function readWithStagedResponseOverlay<T>(
    doc: Y.Doc,
    command: { documentId: DocumentId; responseId?: string | null },
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> {
    if (!command.responseId) return read(toDocHandle(doc));
    return input.agentEdit
      .withResponseDocument(command.responseId, command.documentId, toDocHandle(doc), read)
      .then((staged) => staged ?? read(toDocHandle(doc)));
  }

  function readStagedResponseOnly<T>(
    command: { documentId: DocumentId; responseId?: string | null },
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> | null {
    if (!command.responseId) return null;
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
    if (command.threadId) {
      const isStagedOnlyCreatedDocument = Boolean(
        command.responseId &&
          input.agentEdit
            .responseDocuments(command.responseId, command.threadId)
            .created.includes(command.documentId),
      );
      if (isStagedOnlyCreatedDocument) {
        const stagedOnly = readStagedResponseOnly(command, read);
        if (stagedOnly !== null) return Ok(await stagedOnly);
      }
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

  async function pushManifestMutation(
    mutation: { workDraftBranchId?: string; policy?: "manual" | "auto" } | undefined,
  ): Promise<void> {
    if (mutation?.workDraftBranchId) {
      await input.branchPush.pushAutoBranchAfterThreadPeerWrite({
        workDraftBranchId: mutation.workDraftBranchId,
      });
    }
  }

  return {
    pullThreadPeer(command) {
      return input.branchPulls.pullThreadPeer(command);
    },
    flushBranchLivePull(documentId) {
      return input.branchPulls.flushLivePull(documentId);
    },
    readEffectiveMarkdown(command) {
      return readEffective(
        command,
        (doc) => input.documents.serializeDocument(command.documentId, unwrapDoc(doc)),
        () => input.documents.readAsMarkdown(command.documentId),
      ) as Promise<Result<string, SyncError>>;
    },
    readEffectiveHashlines(command) {
      return readEffective(
        command,
        async (doc) => input.model.serializeBlockLines(doc, input.codec),
        () =>
          input.liveCoordinator.withDocument(command.documentId, async (doc) =>
            Ok(input.model.serializeBlockLines(toDocHandle(doc), input.codec)),
          ),
      ) as Promise<Result<string[], SyncError>>;
    },
    async resolveManifestMembership(command) {
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
      await pushManifestMutation(
        await input.branches.recordManifestDocumentCreated(documentId, view),
      );
    },
    async recordManifestDocumentDeleted(
      documentId: DocumentId,
      view?: { projectId: ProjectId; workId?: WorkId | null; threadId?: ThreadId | null },
    ) {
      await pushManifestMutation(
        await input.branches.recordManifestDocumentDeleted(documentId, view),
      );
    },
  };
}
