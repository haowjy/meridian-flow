import {
  type AgentEditCodecFactory,
  cutRevision,
  isDocumentNotFoundError,
  type LoroDocument,
  loroModel,
  toLoroHandle,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { encodeRoomVersion } from "@meridian/document-model";
import { settledAheads } from "@meridian/markup/links";
import type { Schema } from "prosemirror-model";
import { Ok, type Result } from "../../../shared/result.js";
import type {
  EffectiveBlocksRead,
  EffectiveDocumentReader,
  EffectiveReadVersion,
  HashlineRead,
  SyncError,
} from "../contracts.js";
import { inView, readHashlines, viewRevision } from "./document-revision.js";
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
  documents: Pick<MarkdownDocumentEngine, "readRoom" | "serializeVersionedDocument">;
  schema: Schema;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  resolveFiletype(documentId: DocumentId): Promise<string | null>;
}): Omit<EffectiveDocumentReader, "writeWorkCreatedContent"> {
  const model = loroModel(input.schema);

  function viewOf(command: EffectiveReadInput): LinkView {
    return command.destination === "draft"
      ? { kind: "draft", draftId: command.draft }
      : { kind: "live" };
  }

  async function spelling(command: EffectiveReadInput, doc: LoroDocument) {
    const holder = { documentId: command.documentId, view: viewOf(command) };
    const blocks = model.projectBlocks(toLoroHandle(doc)).map((block) => block.node);
    await input.links.prepare({ holders: [holder], stored: blocks });
    return input.links.holder(holder);
  }

  async function readEffective<T>(
    command: EffectiveReadInput,
    read: (doc: LoroDocument, draft: string | null) => Promise<T>,
    draft: DraftId | null = command.destination === "draft" ? command.draft : null,
  ): Promise<Result<T, SyncError>> {
    const room: DocumentRoom = draft
      ? { kind: "fork", draftId: draft, documentId: command.documentId }
      : { kind: "live", documentId: command.documentId };
    return Ok(await input.documents.readRoom(room, (doc) => read(doc, draft)));
  }

  const versionOf = (doc: LoroDocument) => encodeRoomVersion(doc.docs.shownVersion());

  return {
    async readEffectiveRevision(command) {
      try {
        const result = await readEffective(command, async (doc, view) => {
          const scope = await spelling(command, doc);
          const blocks = model.projectBlocks(toLoroHandle(doc)).map((block) => block.node);
          return viewRevision(cutRevision({ version: versionOf(doc), blocks }, scope), view);
        });
        return result.ok ? result.value : null;
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return null;
        throw cause;
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
        async (doc, view) =>
          inView(
            await input.documents.serializeVersionedDocument(documentId, doc, { kind: "live" }),
            view,
          ),
        draft,
      ),
    readEffectiveMarkdown(command) {
      return readEffective(command, async (doc, view) =>
        inView(
          await input.documents.serializeVersionedDocument(
            command.documentId,
            doc,
            viewOf(command),
          ),
          view,
        ),
      );
    },
    readEffectiveBlocks(command) {
      return readEffective(
        { documentId: command.documentId, destination: "live" },
        async (doc, view): Promise<EffectiveBlocksRead> => {
          const scope = await spelling(command, doc);
          const blocks = model.projectBlocks(toLoroHandle(doc)).map((block) => block.node);
          const version = versionOf(doc);
          return {
            content: blocks,
            version: view ? "draft" : "live",
            revision: viewRevision(cutRevision({ version, blocks }, scope), view),
            holderUri: scope.holder.uri,
            roomVersion: version,
            aheadSettlements: settledAheads(blocks, scope),
          };
        },
        command.destination === "draft" ? command.draft : null,
      );
    },
    readEffectiveHashlines(command) {
      return readEffective(command, async (doc, view): Promise<HashlineRead> => {
        const [scope, verbatim] = await Promise.all([
          spelling(command, doc),
          isCodeDocument(input.resolveFiletype, command.documentId),
        ]);
        return inView(
          readHashlines(toLoroHandle(doc), versionOf(doc), scope, model, input.codec, verbatim),
          view,
        );
      });
    },
  };
}
