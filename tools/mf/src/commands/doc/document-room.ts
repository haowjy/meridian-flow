import {
  createAgentEditCodecFactory,
  LoroDocument,
  loroModel,
  overwriteWithAssigned,
  toLoroHandle,
} from "@meridian/agent-edit/integration";
import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import {
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  freshPeerId,
  inText,
  RoomDocs,
  type RoomVersion,
  readDocument,
  type ShapeBlock,
  versionCovers,
} from "@meridian/document-model";
import { nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { CliError } from "../../core/cli-error";
import { LoroSocket } from "../../core/loro-socket";
import type { Session } from "../../core/session";

const SYNC_TIMEOUT_MS = 15_000;

const schema = buildDocumentSchema();
const codec = createAgentEditCodecFactory(mdxCodec({ schema }));

async function openDocument(session: Session, documentRoom: DocumentRoom) {
  const live = RoomDocs.create(shapeSchemaOf(schema), freshPeerId());
  const docs = documentRoom.kind === "fork" ? RoomDocs.draftOf(live, freshPeerId()) : live;
  const room = loroRoomName(documentRoom);
  const socket = await LoroSocket.open(session);
  const close = () => {
    socket.close();
    if (docs !== live) docs.free();
    live.free();
  };
  try {
    const liveAnswer = await socket.join(loroRoomName(liveRoomOf(documentRoom)), {
      peer: live.peer,
      version: new Uint8Array(),
      onBatch: (envelope) => {
        live.importBatch(decodeEnvelope(envelope));
        if (docs !== live) docs.forward();
      },
    });
    await caughtUp(live, decodeRoomVersion(liveAnswer.version));
    const answer =
      docs === live
        ? liveAnswer
        : await socket.join(room, {
            peer: docs.peer,
            version: new Uint8Array(),
            onBatch: (envelope) => docs.importBatch(decodeEnvelope(envelope)),
          });
    if (answer.permission !== "write")
      throw new CliError("http_error", "The document's room is read-only for this session");
    if (docs !== live) {
      await caughtUp(docs, decodeRoomVersion(answer.version));
      docs.forward();
    }
    return { docs, room, socket, close };
  } catch (error) {
    close();
    throw error;
  }
}

export async function readMarkdown(session: Session, room: DocumentRoom): Promise<string> {
  const opened = await openDocument(session, room);
  try {
    return codec
      .forScope(UNSCOPED_DOCUMENT_LINKS)
      .serialize(readDocument(opened.docs).map((block) => nodeOf(schema, block)));
  } finally {
    opened.close();
  }
}

export async function writeMarkdown(
  session: Session,
  documentId: string,
  markdown: string | ((current: string) => string),
  filetype?: string,
): Promise<void> {
  const { docs, room, socket, close } = await openDocument(session, {
    kind: "live",
    documentId,
  });
  try {
    const text =
      typeof markdown === "string"
        ? markdown
        : markdown(
            codec
              .forScope(UNSCOPED_DOCUMENT_LINKS)
              .serialize(readDocument(docs).map((block) => nodeOf(schema, block))),
          );
    const blocks =
      filetype === "source"
        ? [schema.nodes.code_block.create({ language: filetype }, schema.text(text))]
        : codec.parse(text).blocks;
    const before = docs.shownVersion();
    const written = overwriteWithAssigned({
      doc: toLoroHandle(new LoroDocument(docs, schema)),
      model: loroModel(schema),
      codec: codec.forScope(UNSCOPED_DOCUMENT_LINKS),
      documentId,
      content: text,
      blocks,
    });
    if (!written.ok)
      throw new CliError("http_error", `The document refused its text: ${written.message}`);
    const update = docs.exportSince(before);
    if (update.size > 0) await socket.send(room, encodeEnvelope(update));
  } finally {
    close();
  }
}

export async function typeOver(
  session: Session,
  documentRoom: DocumentRoom,
  find: string,
  replace: string,
): Promise<void> {
  const { docs, room, socket, close } = await openDocument(session, documentRoom);
  try {
    const hits: { id: ShapeBlock["id"]; at: number }[] = [];
    const visit = (blocks: readonly ShapeBlock[]) => {
      for (const block of blocks) {
        if (block.kind === "container") visit(block.children);
        else {
          const doc = docs.textOf(block.id);
          const chars = doc ? Array.from(inText(doc, (text) => text.toString())) : [];
          const wanted = Array.from(find);
          for (let at = 0; at + wanted.length <= chars.length; at++)
            if (wanted.every((char, i) => chars[at + i] === char)) hits.push({ id: block.id, at });
        }
      }
    };
    visit(readDocument(docs));
    const [hit] = hits;
    if (!hit || hits.length > 1)
      throw new CliError("not_found", `"${find}" does not occur exactly once in one paragraph`);
    const before = docs.shownVersion();
    const { doc } = docs.writableText(hit.id);
    inText(doc, (text) => {
      text.delete(hit.at, Array.from(find).length);
      if (replace) text.insert(hit.at, replace);
    });
    doc.commit();
    await socket.send(room, encodeEnvelope(docs.exportSince(before)));
  } finally {
    close();
  }
}

async function caughtUp(docs: RoomDocs, server: RoomVersion) {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  while (!versionCovers(docs.version(), server)) {
    if (Date.now() > deadline)
      throw new CliError("unavailable", `The document's room did not sync in ${SYNC_TIMEOUT_MS}ms`);
    await new Promise((done) => setTimeout(done, 20));
  }
}
