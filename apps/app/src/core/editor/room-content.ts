import type { RoomDocs, ShapeSchema } from "@meridian/document-model";
import { readProseMirror, shapeSchemaOf } from "@meridian/loro-prosemirror";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";

let schema: ReturnType<typeof buildDocumentSchema> | null = null;
let shape: ShapeSchema | null = null;

export const roomSchema = () => (schema ??= buildDocumentSchema());

export const documentShape = (): ShapeSchema => (shape ??= shapeSchemaOf(roomSchema()));

export function roomContent(docs: RoomDocs) {
  return readProseMirror(docs, roomSchema());
}
