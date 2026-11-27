import { freshPeerId, RoomDocs } from "@meridian/document-model";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import type { DocumentLinkScope } from "@meridian/markup";
import { Fragment, type Node as PMNode } from "prosemirror-model";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import { parseDocumentAddress } from "../document-address.js";
import { LoroDocument, type LoroDocumentModel, toLoroHandle } from "../model/loro-model.js";
import type { ReadCommand } from "./command-schema.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { toOutcome } from "./response-format.js";
import type { WriteOutcome } from "./types.js";
import { errorResponse, readSuccess } from "./write-helpers.js";

export function readStaticMarkdown(
  deps: { model: LoroDocumentModel; codec: AgentEditCodecFactory; links: DocumentLinkScope },
  markdown: string,
  command: ReadCommand,
): WriteOutcome {
  const address = parseDocumentAddress(command.file, command.documentId);
  if (!address.ok)
    return toOutcome("read", errorResponse("invalid_write", address.message, command.file));
  const docs = RoomDocs.create(shapeSchemaOf(deps.model.schema), freshPeerId());
  try {
    const handle = toLoroHandle(new LoroDocument(docs, deps.model.schema));
    // A block's hash comes from its id, and every read builds a fresh copy: ids by position keep
    // one text's hashes the same from one read to the next.
    let next = 0;
    const parsed = deps.codec.parse(markdown);
    deps.model.insertBlocks(handle, null, {
      ...parsed,
      blocks: parsed.blocks.map((block) => numbered(block as PMNode, () => `s${next++}`)),
    });
    const renderer = createDocumentRenderer(deps);
    const selection = renderer.selectReadBlocks(handle, command, address);
    const result = selection.ok
      ? readSuccess(
          renderer.renderRead(
            selection,
            deps.codec.forScope(deps.links),
            command.format === "outline" ? "outline" : "full",
          ),
        )
      : errorResponse(
          selection.code,
          selection.message,
          address.filePath,
          selection.documentBlocks,
        );
    return toOutcome("read", result, command.file);
  } finally {
    docs.free();
  }
}

function numbered(node: PMNode, nextId: () => string): PMNode {
  if (node.isText) return node;
  const children: PMNode[] = [];
  node.forEach((child) => {
    children.push(numbered(child, nextId));
  });
  const attrs =
    node.type.spec.attrs?.id === undefined ? node.attrs : { ...node.attrs, id: nextId() };
  return node.type.create(attrs, Fragment.fromArray(children), node.marks);
}
