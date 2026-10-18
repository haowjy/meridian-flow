/** Effective draft reads with staged-response overlays . */
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
  DraftPeerShadowAccess,
  EffectiveReadVersion,
  HashlineRead,
  SyncError,
} from "../contracts.js";
import type { ThreadPeerAgentEditCore } from "./agent-edit-cores.js";
import type { Branches } from "./branches.js";
import { documentRevision, versioned } from "./document-revision.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import type { DraftPullService } from "./draft-pulls.js";
import { DraftNotFoundError } from "./draft-resolver.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { PeerRetirement } from "./peer-retirement.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
} & EffectiveReadVersion;

export function createEffectiveDocumentReader(input: {
  drafts: ApplicationDraftStore;
  draftCoordinator: DraftCoordinator;
  draftPulls: DraftPullService;
  liveCoordinator: DocumentCoordinator;
  agentEdit: ThreadPeerAgentEditCore;
  documents: Pick<MarkdownDocumentEngine, "serializeVersionedDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  branches: Pick<Branches, "viewForWork">;
  retirePeers: PeerRetirement;
  deferUntilCommit(callback: () => Promise<void>): boolean;
}): DraftPeerShadowAccess {
  /** The view a read spells in: the version it reads. */
  async function viewOf(command: EffectiveReadInput): Promise<LinkView> {
    return command.destination === "draft"
      ? input.branches.viewForWork(command.workId)
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
      // A read never ensures a peer or a draft (S1): it pulls a peer the thread already has,
      // in the Work's active branch.
      const view = await viewOf(command);
      if (view.kind === "branch") {
        try {
          await input.drafts.resolveThreadDraft(command.documentId, command.threadId);
          await input.draftPulls.pullThreadPeer({
            documentId: command.documentId,
            threadId: command.threadId,
            branchId: view.branchId,
          });
        } catch (cause) {
          if (!(cause instanceof DraftNotFoundError)) throw cause;
        }
      }
      try {
        const documentDraft = await input.drafts.resolveThreadDraft(
          command.documentId,
          command.threadId,
        );
        return Ok(await readEffectiveDraft(documentDraft, read));
      } catch (cause) {
        if (!(cause instanceof DraftNotFoundError)) throw cause;
      }
      await input.draftPulls.flushLivePull(command.documentId);
      try {
        const workDraft = await input.drafts.resolveWorkDraftForThread(
          command.documentId,
          command.threadId,
        );
        return Ok(await readEffectiveDraft(workDraft, read));
      } catch (cause) {
        if (!(cause instanceof DraftNotFoundError)) throw cause;
      }
    }
    return fallback();
  }

  /** Live content, rendered by the same reader as every draft. */
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

  function readEffectiveDraft<T>(
    documentDraft: { draftId: string },
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<T> {
    return input.draftCoordinator.readDraft(documentDraft.draftId, async (doc) =>
      read(toDocHandle(doc)),
    );
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
    flushDraftLivePull(documentId) {
      return input.draftPulls.flushLivePull(documentId);
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
    ensureCreatedDocumentDraft(command) {
      return input.drafts.ensureCreatedDocumentDraft(command);
    },
    async retractCreatedDocumentDraft(command) {
      const retracted = await input.drafts.retractCreatedDocumentDraft(command);
      if (retracted.outcome === "retracted" && retracted.deleted.length > 0) {
        // Rooms and pooled cores hold the deleted drafts' state; exactly those go, once
        // the deletion is durable (an abort keeps the drafts). Another Work's peers on
        // the same document are not this retraction's.
        const { deleted } = retracted;
        const retire = () =>
          input.retirePeers(
            deleted.map(({ draftId, threadId }) =>
              threadId
                ? {
                    draftId,
                    documentId: command.documentId,
                    threadId,
                    cause: "document_discarded" as const,
                  }
                : { draftId, documentId: command.documentId, threadId: null },
            ),
          );
        if (!input.deferUntilCommit(retire)) await retire();
      }
      return retracted.outcome;
    },
  };
}
