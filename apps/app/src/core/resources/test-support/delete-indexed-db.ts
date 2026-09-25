/** Test-only cleanup for the IndexedDB fixtures used by resource tests. */
export function deleteIndexedDb(name: string): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB deletion blocked: ${name}`));
  });
}
