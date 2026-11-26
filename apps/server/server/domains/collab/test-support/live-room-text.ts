import type { DocumentRoom } from "@meridian/contracts/protocol";
import { encodeEnvelope, freshPeerId, readDocument, writeDocument } from "@meridian/document-model";
import type { DocumentRooms } from "@meridian/document-model/rooms";
import { blocksOf, nodeOf } from "@meridian/loro-prosemirror";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, withBlockIds } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const live = (documentId: string): DocumentRoom => ({ kind: "live", documentId });

/** The document's blocks in its Live room now, with ids. */
export async function liveBlocks(
  rooms: DocumentRooms<unknown>,
  documentId: string,
): Promise<PMNode[]> {
  const docs = await rooms.read(live(documentId));
  try {
    return readDocument(docs).map((block) => nodeOf(schema, block));
  } finally {
    docs.free();
  }
}

/** The document's Live text as Markdown. */
export async function liveMarkdown(
  rooms: DocumentRooms<unknown>,
  documentId: string,
): Promise<string> {
  return codec.serialize(await liveBlocks(rooms, documentId), UNSCOPED_DOCUMENT_LINKS);
}

/**
 * The writer changes the document to `want(current)`, as a client's batch. Blocks `want` returns
 * without an id are new.
 */
export async function writerEdit(
  rooms: DocumentRooms<unknown>,
  documentId: string,
  want: (current: PMNode[]) => readonly PMNode[],
): Promise<void> {
  const room = live(documentId);
  const docs = await rooms.read(room, { peer: freshPeerId() });
  try {
    const since = docs.shownVersion();
    const current = readDocument(docs).map((block) => nodeOf(schema, block));
    const next = withBlockIds(schema.topNodeType.create(null, [...want(current)]));
    writeDocument(docs, blocksOf(next));
    const update = docs.exportSince(since);
    if (update.size > 0) await rooms.write(room, encodeEnvelope(update), "socket:writer");
  } finally {
    docs.free();
  }
}

/**
 * The writer changes the document's text to `markdown`. A paragraph whose text is unchanged keeps
 * its block, as it would under the writer's typing; the rest are new.
 */
export function writeLiveMarkdown(
  rooms: DocumentRooms<unknown>,
  documentId: string,
  markdown: string,
): Promise<void> {
  return writerEdit(rooms, documentId, (current) => {
    const unused = [...current];
    return (codec.parse(markdown).blocks as PMNode[]).map((block) => {
      const at = unused.findIndex((kept) =>
        kept.eq(block.type.create({ ...block.attrs, id: kept.attrs.id }, block.content)),
      );
      if (at < 0) return block;
      const [kept] = unused.splice(at, 1);
      return kept as PMNode;
    });
  });
}
