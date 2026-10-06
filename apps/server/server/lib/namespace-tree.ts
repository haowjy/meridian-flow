/**
 * A thread's live context port as the tree the collab domain's namespace
 * step acts on (D66): a move goes through `commitWriterLocation`, so links
 * follow (#694), and the document must be the one the change recorded.
 */
import type { NamespaceTree } from "../domains/collab/index.js";
import type { ContextError, ContextPort } from "../domains/context/ports/context-port.js";

export function namespaceTree(
  port: ContextPort,
  options: { linksSettled?: boolean } = {},
): NamespaceTree<ContextError> {
  return {
    move: (fromUri, toUri, documentId) =>
      port.commitWriterLocation(fromUri, toUri, {
        expected: { kind: "file", nodeId: documentId },
        linksSettled: options.linksSettled,
      }),
    delete: (uri, documentId) => port.delete(uri, { expected: { kind: "file", documentId } }),
    restore: (uri, documentId) => port.restore(uri, { documentId }),
    async settleLinks(uris) {
      await port.settleLinks(uris);
      return namespaceTree(port, { linksSettled: true });
    },
    lock: (uris) => port.lockTree(uris),
  };
}
