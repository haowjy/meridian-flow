/**
 * A document's text, written the way an editor writes it: join the document's `live:` room on
 * `/ws/loro`, wait for the room's state, overwrite the copy with the parsed blocks (blocks left as
 * they were keep their ids) and send what changed as one batch. The tree list makes the document;
 * its content is the room's.
 */
import {
  createAgentEditCodecFactory,
  LoroDocument,
  loroModel,
  overwriteWithAssigned,
  toLoroHandle,
} from "@meridian/agent-edit/integration";
import {
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  freshPeerId,
  RoomDocs,
  type RoomVersion,
  versionCovers,
} from "@meridian/document-model";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { CliError } from "../../core/cli-error";
import { LoroSocket } from "../../core/loro-socket";
import type { Session } from "../../core/session";

const SYNC_TIMEOUT_MS = 15_000;

/**
 * Writes `markdown` over the document's text. Resolves once the room acknowledges the batch: the
 * room has imported it, and readers see it.
 */
export async function writeMarkdown(
  session: Session,
  documentId: string,
  markdown: string,
  /** A `source` document holds its text as one code block, byte for byte; prose is parsed. */
  filetype?: string,
): Promise<void> {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodecFactory(mdxCodec({ schema }));
  const docs = RoomDocs.create(shapeSchemaOf(schema), freshPeerId());
  const room = `live:${documentId}`;
  const socket = await LoroSocket.open(session);
  try {
    const answer = await socket.join(room, {
      peer: docs.peer,
      version: new Uint8Array(),
      onBatch: (envelope) => docs.importBatch(decodeEnvelope(envelope)),
    });
    if (answer.permission !== "write")
      throw new CliError("http_error", "The document's room is read-only for this session");
    await caughtUp(docs, decodeRoomVersion(answer.version));
    const blocks =
      filetype === "source"
        ? [schema.nodes.code_block.create({ language: filetype }, schema.text(markdown))]
        : codec.parse(markdown).blocks;
    const before = docs.version();
    const written = overwriteWithAssigned({
      doc: toLoroHandle(new LoroDocument(docs, schema)),
      model: loroModel(schema),
      codec: codec.forScope(UNSCOPED_DOCUMENT_LINKS),
      documentId,
      content: markdown,
      blocks,
    });
    if (!written.ok)
      throw new CliError("http_error", `The document refused its text: ${written.message}`);
    const update = docs.exportSince(before);
    if (update.size > 0) await socket.send(room, encodeEnvelope(update));
  } finally {
    socket.close();
    docs.free();
  }
}

/** Waits until the copy holds every op of the room version the Join answered with. */
async function caughtUp(docs: RoomDocs, server: RoomVersion) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (!versionCovers(docs.version(), server)) {
    if (Date.now() > deadline)
      throw new CliError("unavailable", `The document's room did not sync in ${SYNC_TIMEOUT_MS}ms`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
