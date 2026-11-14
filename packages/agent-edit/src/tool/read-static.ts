// Reads Markdown that is not a tracked document (text extracted from an EPUB or PDF) through
// the same renderer as a document read: hashes, outline, `#heading` sections, `in` and `around`.

import type { DocumentLinkScope } from "@meridian/markup";
import * as Y from "yjs";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import { parseDocumentAddress } from "../document-address.js";
import { toDocHandle } from "../handles.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ReadCommand } from "./command-schema.js";
import { createDocumentRenderer } from "./document-renderer.js";
import { toOutcome } from "./response-format.js";
import type { WriteOutcome } from "./types.js";
import { errorResponse, readSuccess } from "./write-helpers.js";

/**
 * A block's hash comes from the Yjs identity of its element. Every read builds a fresh document,
 * so a fixed client id is what keeps one text's hashes the same from one read to the next.
 */
const STATIC_CLIENT_ID = 1;

export function readStaticMarkdown(
  deps: { model: AgentEditModel; codec: AgentEditCodecFactory; links: DocumentLinkScope },
  markdown: string,
  command: ReadCommand,
): WriteOutcome {
  const address = parseDocumentAddress(command.file, command.documentId);
  if (!address.ok)
    return toOutcome("read", errorResponse("invalid_write", address.message, command.file));
  const doc = new Y.Doc();
  doc.clientID = STATIC_CLIENT_ID;
  const handle = toDocHandle(doc);
  deps.model.transact(
    handle,
    () => deps.model.insertBlocks(handle, null, deps.codec.parse(markdown)),
    "static-read",
  );
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
    : errorResponse(selection.code, selection.message, address.filePath, selection.documentBlocks);
  return toOutcome("read", result, command.file);
}
