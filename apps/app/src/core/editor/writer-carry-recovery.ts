/** Re-expresses pending writer operations whose own identities/anchors survive retirement. */
import {
  findItem,
  hasLiveContent,
  integrateFreshCopy,
  rootTypeKey,
} from "@meridian/agent-edit/yjs-mutation";
import { RESTORATION_CLAIMS_TYPE } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export function recoverWriterCarry(
  document: Y.Doc,
  sourceState: Uint8Array,
  pendingUpdate: Uint8Array,
): boolean {
  const source = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(source, sourceState);
    const remaining = Y.decodeUpdateV2(pendingUpdate).structs.filter(
      (item): item is Y.Item => item instanceof Y.Item,
    );
    const copies: Array<{ source: Y.ID; target: Y.ID; length: number }> = [];
    const resolve = (id: Y.ID | null): Y.ID | null => {
      if (!id) return null;
      const copy = copies.find(
        (range) =>
          range.source.client === id.client &&
          range.source.clock <= id.clock &&
          id.clock < range.source.clock + range.length,
      );
      return copy
        ? Y.createID(copy.target.client, copy.target.clock + id.clock - copy.source.clock)
        : findItem(document, id)
          ? id
          : null;
    };
    let lost = false;
    document.transact((transaction) => {
      // A rescued parent or sibling may unlock another pending operation. The
      // source's clock prefix alone never creates an insertion dependency here.
      let progress = true;
      while (remaining.length && progress) {
        progress = false;
        for (let index = 0; index < remaining.length; ) {
          const item = remaining[index];
          if (!item) break;
          const original = findItem(source, item.id);
          if (original && rootTypeKey(original) === RESTORATION_CLAIMS_TYPE) {
            remaining.splice(index, 1);
            progress = true;
            continue;
          }
          const id = integrateFreshCopy(transaction, source, item, resolve);
          if (!id) {
            index += 1;
            continue;
          }
          copies.push({ source: item.id, target: id, length: item.length });
          remaining.splice(index, 1);
          progress = true;
        }
      }
      lost = remaining.some((item) => hasLiveContent(source, item));
    });
    return lost;
  } finally {
    source.destroy();
  }
}
