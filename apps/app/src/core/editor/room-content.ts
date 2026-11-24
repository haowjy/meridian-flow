/** The document schema every copy in this browser shapes its docs by (design §1). */
import type { RoomDocs, ShapeSchema } from "@meridian/document-model";
import { readProseMirror, shapeSchemaOf } from "@meridian/loro-prosemirror";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
let shape: ShapeSchema | null = null;

/** The shared schema: the one the server and agent-edit read the same docs with. */
export const roomSchema = () => (schema ??= buildDocumentSchema());

/**
 * Every copy configures its styles from the shared schema, not the editor's TipTap schema, so every
 * peer stores marks alike.
 */
export const documentShape = (): ShapeSchema => (shape ??= shapeSchemaOf(roomSchema()));

/** What the copy shows now, as a ProseMirror document in the shared schema. */
export function roomContent(docs: RoomDocs) {
  return readProseMirror(docs, roomSchema());
}
