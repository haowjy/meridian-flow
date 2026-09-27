/** Opaque identity of Yjs content, including pure deletions and formatting. */
import { createHash } from "node:crypto";
import * as Y from "yjs";

export function documentRevision(doc: Y.Doc): string {
  return `y1:${createHash("sha256")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .digest("base64url")}`;
}
