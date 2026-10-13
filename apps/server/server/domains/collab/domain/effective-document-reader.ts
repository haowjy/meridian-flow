/** Effective branch reads with staged-response overlays . */
import {
  type AgentEditCodecFactory,
  type DocHandle,
  type DocumentCoordinator,
  isDocumentNotFoundError,
  toDocHandle,
  unwrapDoc,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { spelledLinks } from "@meridian/markup/links";
import type * as Y from "yjs";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  BranchPeerShadowAccess,
  EffectiveReadVersion,
  HashlineRead,
  SyncError,
} from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchPullService } from "./branch-pulls.js";
import { BranchNotFoundError } from "./branch-resolver.js";
import { documentRevision, versioned } from "./document-revision.js";
import type { Drafts } from "./drafts.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { PeerRetirement } from "./peer-retirement.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
} & EffectiveReadVersion;

export function createEffectiveDocumentReader(input: {
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchPulls: BranchPullService;
  liveCoordinator: DocumentCoordinator;
  agentEdit: ThreadPeerAgentEditCore;
  documents: Pick<MarkdownDocumentEngine, "serializeVersionedDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  drafts: Pick<Drafts, "viewForWork">;
  retirePeers: PeerRetirement;
  deferUntilCommit(callback: () => Promise<void>): boolean;
}): BranchPeerShadowAccess {
  /** The view a read spells in: the version it reads. */
  async function viewOf(command: EffectiveReadInput): Promise<LinkView> {
    return command.destination === "draft"
      ? input.drafts.viewForWork(command.workId)
      : { kind: "live" };
  }

  async function spelling(command: EffectiveReadInput, doc: Y.Doc) {
    const holder = { documentId: command.documentId, view: await viewOf(command) };
    await input.links.prepare({ holders: [holder], docs: [doc] });
    return input.links.holder(holder);
  }

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

  /**
   * Reads the document's effective Y.Doc for this command: the reply's staged
   * create, its thread peer, its Work draft, or else live content. Choosing
   * the content source never chooses the view: every source renders through
   * the same `read`, which spells in the command's own view.
   */
  async function readEffective<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<Result<T, SyncError>> {
    const lease = stagedInVersion(command)
      ? await input.agentEdit.prepare(command.responseId, command.documentId)
      : null;
    if (lease) {
      try {
        return Ok(await read(lease.doc));
      } finally {
        lease.dispose();
      }
    }
    const fallback = () => readLive(command, read);
    if (command.destination === "live") return fallback();
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
        return Ok(await readEffectiveBranch(branch, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
      await input.branchPulls.flushLivePull(command.documentId);
      try {
        const workDraft = await input.branches.resolveWorkDraftBranchForThread(
          command.documentId,
          command.threadId,
        );
        return Ok(await readEffectiveBranch(workDraft, read));
      } catch (cause) {
        if (!(cause instanceof BranchNotFoundError)) throw cause;
      }
    }
    return fallback();
  }

  /** Live content, rendered by the same reader as every branch. */
  async function readLive<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<Result<T, SyncError>> {
    try {
      return Ok(
        await input.liveCoordinator.withDocument(command.documentId, (doc) =>
          read(toDocHandle(doc)),
        ),
      );
    } catch (cause) {
      if (isDocumentNotFoundError(cause))
        return Err({ code: "not_found", documentId: command.documentId });
      throw cause;
    }
  }

  async function readEffectiveBranch<T>(
    branch: { branchId: string; doc: Y.Doc },
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return input.branchCoordinator.readBranch(branch.branchId, async (doc) =>
        read(toDocHandle(doc)),
      );
    } finally {
      branch.doc.destroy();
    }
  }

  return {
    async readEffectiveRevision(command) {
      try {
        const result = await readEffective(command, async (handle) => {
          const doc = unwrapDoc(handle);
          return documentRevision(doc, await spelling(command, doc));
        });
        return result.ok ? result.value : null;
      } catch {
        return null;
      }
    },
    flushBranchLivePull(documentId) {
      return input.branchPulls.flushLivePull(documentId);
    },
    readEffectiveMarkdown(command) {
      return readEffective(command, async (doc) =>
        input.documents.serializeVersionedDocument(
          command.documentId,
          unwrapDoc(doc),
          await viewOf(command),
        ),
      );
    },
    readEffectiveHashlines(command) {
      return readEffective(command, async (handle): Promise<HashlineRead> => {
        const doc = unwrapDoc(handle);
        const scope = await spelling(command, doc);
        const codec = input.codec.forScope(scope);
        const read = versioned(doc, scope, (doc) =>
          input.model.serializeBlockLines(toDocHandle(doc), codec),
        );
        const links = input.model
          .projectBlocks(toDocHandle(doc))
          .map((block) => spelledLinks([block], scope));
        return { ...read, links, holder: { uri: scope.holder.uri, view: scope.holder.view } };
      });
    },
    ensureCreatedDraftBranch(command) {
      return input.branches.ensureCreatedDraftBranch(command);
    },
    async retractCreatedDraftBranch(command) {
      const retracted = await input.branches.retractCreatedDraftBranch(command);
      if (retracted.outcome === "retracted" && retracted.deleted.length > 0) {
        // Rooms and pooled cores hold the deleted branches' state; exactly those go, once
        // the deletion is durable (an abort keeps the branches). Another Work's peers on
        // the same document are not this retraction's.
        const { deleted } = retracted;
        const retire = () =>
          input.retirePeers(
            deleted.map(({ branchId, threadId }) =>
              threadId
                ? {
                    branchId,
                    documentId: command.documentId,
                    threadId,
                    cause: "document_discarded" as const,
                  }
                : { branchId, documentId: command.documentId, threadId: null },
            ),
          );
        if (!input.deferUntilCommit(retire)) await retire();
      }
      return retracted.outcome;
    },
  };
}
