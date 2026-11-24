/** Shared agent-edit and markdown runtime construction for collab compositions. */
import {
  type AgentEditCodecFactory,
  type AgentEditRooms,
  createAgentEditCodecFactory,
  createLoroEditCore,
  type DocumentEdits,
  type LoroEditCoreOptions,
  type WriteOrdinals,
} from "@meridian/agent-edit/integration";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { mdxCodec, verbatimCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { AgentEditCore } from "./agent-edit-cores.js";
import { scopeMarkdownEngine } from "./document-link-scope-doors.js";
import { createScopedDocumentLinks } from "./document-links-port.js";
import type { DocumentWriteHookRunner } from "./document-projection-refresher.js";
import { codeFiletypeOf } from "./document-schema-type.js";
import { createImportLinkBinder, createLinkBinder } from "./link-binding.js";
import { createMarkdownDocumentEngine } from "./markdown-document.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";

type AgentEditObservability = Pick<
  LoroEditCoreOptions,
  "onUnexpectedWriteError" | "onLinkSpliceFallback" | "onObservationFailed"
>;

export function createAgentEditRuntime<Tx>(input: {
  /** The model's reads and writes: agent-edit's Loro core on the server's rooms. */
  loro: {
    rooms: AgentEditRooms;
    ordinals: WriteOrdinals;
    documentEdits: DocumentEdits;
    authorOfTurn(turnId: string): Promise<string | null>;
  };
  lockDocument(documentId: DocumentId): Promise<void>;
  runDocumentWriteHook: DocumentWriteHookRunner;
  resolveDocumentFiletype(documentId: string): Promise<string | null>;
  observability: AgentEditObservability;
  /** How links and image sources spell, loaded per operation (contract §4.4). */
  links: DocumentLinkScopes;
  /** Durable ahead-ref registration for refs the model's writes mint. */
  aheadRefs: AheadRefRegistrar;
  /** The server's one door to document rooms: the Markdown engine reads and writes through it. */
  rooms: DocumentRooms<Tx>;
  /** Runs work in the caller's transaction, or in one of its own outside any. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Whether a database transaction is open here; whole-document binding refuses to run in one. */
  inTransaction(): boolean;
}) {
  const schema = buildDocumentSchema();
  const markupCodec = mdxCodec({ schema });
  const codec = createAgentEditCodecFactory(markupCodec);
  /** A code document's text is one code block, not Markdown: its codec reads and writes it so. */
  const codecFor = async (documentId: DocumentId): Promise<AgentEditCodecFactory> => {
    const filetype = await codeFiletypeOf(input.resolveDocumentFiletype, documentId);
    return filetype === null
      ? codec
      : createAgentEditCodecFactory(verbatimCodec(markupCodec, schema, filetype));
  };
  const core: AgentEditCore = createLoroEditCore({
    rooms: input.loro.rooms,
    ordinals: input.loro.ordinals,
    schema,
    codec,
    codecFor,
    links: createScopedDocumentLinks({ scopes: input.links, registrar: input.aheadRefs }),
    documentEdits: input.loro.documentEdits,
    authorOfTurn: input.loro.authorOfTurn,
    ...input.observability,
  });
  const markdownDocuments = scopeMarkdownEngine(
    createMarkdownDocumentEngine({
      schema,
      codec: markupCodec,
      exportCodec: mdxCodec({ schema, export: true }),
      links: input.links,
      rooms: input.rooms,
      transaction: input.transaction,
      lockDocument: input.lockDocument,
      afterWrite: input.runDocumentWriteHook,
      resolveFiletype: input.resolveDocumentFiletype,
    }),
    input.links,
  );
  const linkBinder = createLinkBinder({
    codec: markupCodec,
    schema,
    currentBlocks: markdownDocuments.currentBlocks,
    links: input.links,
    registrar: input.aheadRefs,
    resolveFiletype: input.resolveDocumentFiletype,
    inTransaction: input.inTransaction,
  });
  const importBinder = createImportLinkBinder({
    codec: markupCodec,
    schema,
    links: input.links,
    registrar: input.aheadRefs,
    resolveFiletype: input.resolveDocumentFiletype,
    inTransaction: input.inTransaction,
  });
  return {
    schema,
    codec,
    codecFor,
    linkBinder,
    importBinder,
    core,
    markdownDocuments,
    markupCodec,
  };
}
