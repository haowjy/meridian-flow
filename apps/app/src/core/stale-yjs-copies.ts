/**
 * The databases builds on Yjs stored their copies in: a document's (`meridian:document:`) and a
 * tree list's (`meridian:tree-list:v1:`). Nothing reads them since both moved to Loro.
 */
const STALE_PREFIXES = ["meridian:document:", "meridian:tree-list:v1:"];

/** Deletes this browser's Yjs copies. A tab of an old build still holding one delays its delete until it closes. */
export async function deleteStaleYjsCopies(idb: IDBFactory): Promise<void> {
  if (!idb.databases) return;
  for (const { name } of await idb.databases())
    if (name && STALE_PREFIXES.some((prefix) => name.startsWith(prefix))) idb.deleteDatabase(name);
}
