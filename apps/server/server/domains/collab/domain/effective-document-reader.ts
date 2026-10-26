/** Effective document reads for non-tool callers: the same room copy a model call would read. */
import {
  type AgentEditCodecFactory,
  type DocHandle,
  isDocumentNotFoundError,
  toDocHandle,
  unwrapDoc,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { settledAheads, spelledLinks } from "@meridian/markup/links";
import * as Y from "yjs";
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
import type { DraftPullService } from "./draft-pulls.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
  responseId?: string | null;
} & EffectiveReadVersion;

export function createEffectiveDocumentReader(input: {
  drafts: ApplicationDraftStore;
  draftPulls: Pick<DraftPullService, "flushLivePull">;
  agentEdit: ThreadPeerAgentEditCore;
  documents: Pick<MarkdownDocumentEngine, "serializeVersionedDocument">;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  branches: Pick<Branches, "viewForWork">;
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
   * Reads the document's effective Y.Doc for this command: the room copy a model call would
   * read (the reply's pinned destination with its staged writes, the thread's Work draft, or
   * live). Choosing the content source never chooses the view: every source renders through
   * the same `read`, which spells in the command's own view.
   */
  async function readEffective<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle) => Promise<T>,
  ): Promise<Result<T, SyncError>> {
    let room: Awaited<ReturnType<ThreadPeerAgentEditCore["readRoom"]>>;
    try {
      room = await input.agentEdit.readRoom({
        documentId: command.documentId,
        threadId: command.threadId,
        responseId: command.responseId ?? null,
        live: command.destination === "live",
      });
    } catch (cause) {
      if (isDocumentNotFoundError(cause))
        return Err({ code: "not_found", documentId: command.documentId });
      throw cause;
    }
    try {
      return Ok(await read(toDocHandle(room.doc)));
    } finally {
      room.dispose();
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
    readEffectiveBlocks(command) {
      return readEffective(command, async (handle) => {
        const doc = unwrapDoc(handle);
        const scope = await spelling(command, doc);
        const blocks = [...input.model.projectBlocks(toDocHandle(doc))];
        return {
          content: blocks,
          revision: documentRevision(doc, scope),
          holderUri: scope.holder.uri,
          stateVector: Y.encodeStateVector(doc),
          aheadSettlements: settledAheads(blocks, scope),
        };
      });
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
    retractCreatedDocumentDraft(command) {
      return input.drafts.retractCreatedDocumentDraft(command);
    },
  };
}
