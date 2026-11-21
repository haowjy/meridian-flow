/** Effective document reads for non-tool callers: the same view a model call would read. */
import {
  type AgentEditCodecFactory,
  type DocHandle,
  isDocumentNotFoundError,
  toDocHandle,
  unwrapDoc,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { settledAheads } from "@meridian/markup/links";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  DraftPeerShadowAccess,
  EffectiveBlocksRead,
  EffectiveReadVersion,
  HashlineRead,
  SyncError,
} from "../contracts.js";
import type { AgentEditRouter } from "./agent-edit-router.js";
import type { DraftViews } from "./agent-edit-runtime.js";
import { documentRevision, inView, readHashlines, viewRevision } from "./document-revision.js";
import { isCodeDocument } from "./document-schema-type.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";
import type { BlockText } from "./ports/block-text.js";
import type { DocumentLinkScopes } from "./ports/document-link-scope.js";

type EffectiveReadInput = {
  documentId: DocumentId;
  threadId?: ThreadId | null;
} & EffectiveReadVersion;

export function createEffectiveDocumentReader(input: {
  blockText: BlockText;
  agentEdit: AgentEditRouter;
  documents: Pick<MarkdownDocumentEngine, "serializeVersionedDocument">;
  /** Live's view. */
  model: YProsemirrorDocumentModel;
  /** A draft is Live read through the draft's view. */
  draftView: DraftViews;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
}): Omit<DraftPeerShadowAccess, "seedWorkCreates" | "writeWorkCreatedContent"> {
  /** The view a read spells in: the version it reads. */
  async function viewOf(command: EffectiveReadInput): Promise<LinkView> {
    return command.destination === "draft"
      ? { kind: "draft", draftId: command.draft }
      : { kind: "live" };
  }

  async function spelling(command: EffectiveReadInput, doc: Y.Doc) {
    const holder = { documentId: command.documentId, view: await viewOf(command) };
    await input.links.prepare({ holders: [holder], docs: [doc] });
    return input.links.holder(holder);
  }

  /**
   * Reads the document's Live room through `draft`'s view, or Live's view. Choosing the content
   * view never chooses the link view: every source renders through the same `read`, which spells
   * in the command's own view.
   */
  async function readEffective<T>(
    command: EffectiveReadInput,
    read: (doc: DocHandle, model: YProsemirrorDocumentModel, draft: string | null) => Promise<T>,
    draft: DraftId | null = command.destination === "draft" ? command.draft : null,
  ): Promise<Result<T, SyncError>> {
    const model = draft ? input.draftView.model(draft) : input.model;
    let room: Awaited<ReturnType<AgentEditRouter["readRoom"]>>;
    try {
      room = await input.agentEdit.readRoom({ documentId: command.documentId });
    } catch (cause) {
      if (isDocumentNotFoundError(cause))
        return Err({ code: "not_found", documentId: command.documentId });
      throw cause;
    }
    try {
      return Ok(await read(toDocHandle(room.doc), model, draft));
    } finally {
      room.dispose();
    }
  }

  return {
    async readEffectiveRevision(command) {
      try {
        const result = await readEffective(command, async (handle, _model, view) => {
          const doc = unwrapDoc(handle);
          return viewRevision(documentRevision(doc, await spelling(command, doc)), view);
        });
        return result.ok ? result.value : null;
      } catch {
        return null;
      }
    },
    readStoredGrepTexts: ({ documentIds, ...version }) =>
      input.blockText.grepTexts(documentIds, {
        draft: version.destination === "draft" ? version.draft : null,
      }),
    readStoredWordCounts: (documentIds) => input.blockText.wordCounts(documentIds),
    readDraftMarkdown: ({ documentId, draft }) =>
      readEffective(
        { documentId, destination: "live" },
        async (doc, model, view) =>
          inView(
            await input.documents.serializeVersionedDocument(
              documentId,
              unwrapDoc(doc),
              { kind: "live" },
              model,
            ),
            view,
          ),
        draft,
      ),
    readEffectiveMarkdown(command) {
      return readEffective(command, async (doc, model, view) =>
        inView(
          await input.documents.serializeVersionedDocument(
            command.documentId,
            unwrapDoc(doc),
            await viewOf(command),
            model,
          ),
          view,
        ),
      );
    },
    readEffectiveBlocks(command) {
      return readEffective(
        { documentId: command.documentId, destination: "live" },
        async (handle, model, view): Promise<EffectiveBlocksRead> => {
          const doc = unwrapDoc(handle);
          const scope = await spelling(command, doc);
          const blocks = model.projectBlocks(toDocHandle(doc)).map((block) => block.node);
          return {
            content: blocks,
            version: view ? "draft" : "live",
            revision: viewRevision(documentRevision(doc, scope), view),
            holderUri: scope.holder.uri,
            stateVector: Y.encodeStateVector(doc),
            aheadSettlements: settledAheads(blocks, scope),
          };
        },
        command.destination === "draft" ? command.draft : null,
      );
    },
    readEffectiveHashlines(command) {
      return readEffective(command, async (handle, model, view): Promise<HashlineRead> => {
        const doc = unwrapDoc(handle);
        const [scope, verbatim] = await Promise.all([
          spelling(command, doc),
          isCodeDocument(input.resolveFiletype, command.documentId),
        ]);
        return inView(readHashlines(doc, scope, model, input.codec, verbatim), view);
      });
    },
  };
}
