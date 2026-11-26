const STALE_PREFIXES = ["meridian:document:", "meridian:tree-list:v1:"];

/** Deletes this browser's Yjs copies. A tab of an old build still holding one delays its delete until it closes. */
export async function deleteStaleYjsCopies(idb: IDBFactory): Promise<void> {
  if (!idb.databases) return;
  for (const { name } of await idb.databases())
    if (name && STALE_PREFIXES.some((prefix) => name.startsWith(prefix))) idb.deleteDatabase(name);
}
