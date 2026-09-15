/** Exact-cache initialization evidence, committed atomically with its Yjs snapshot. */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

const INITIALIZATION_KEY = "meridian:content-initialization";

/** Replay alone also succeeds for a newly recreated, empty database. */
export function readContentInitialization(database: IDBDatabase): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("custom", "readonly");
    const request = transaction.objectStore("custom").get(INITIALIZATION_KEY);
    transaction.oncomplete = () => {
      const marker = request.result;
      resolve(
        marker?.version === 1 &&
          marker.database === database.name &&
          marker.schema === collabSchemaKeyTag(),
      );
    };
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Content initialization read aborted"));
  });
}

/** Call only for a fresh local reservation or an actual completed server reconciliation. */
export function commitContentInitialization(database: IDBDatabase, document: Y.Doc): Promise<void> {
  const snapshot = Y.encodeStateAsUpdate(document);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["updates", "custom"], "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Content initialization commit aborted"));
    // Append: compaction and other local participants still own their updates.
    transaction.objectStore("updates").add(snapshot);
    transaction
      .objectStore("custom")
      .put(
        { version: 1, database: database.name, schema: collabSchemaKeyTag() },
        INITIALIZATION_KEY,
      );
  });
}
