export const settled = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export type IndexedDbDatabase = {
  /**
   * `run` inside one transaction over `stores`, resolving once it commits. `run` may await only
   * requests on `transaction`: any other wait lets the browser commit it early. A throw aborts it.
   */
  transact<T>(
    stores: readonly string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T>;
  close(): void;
};

export function openIndexedDbDatabase(
  name: string,
  upgrade: (database: IDBDatabase) => void,
): IndexedDbDatabase {
  let opened: Promise<IDBDatabase> | null = null;

  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    }).catch((cause) => {
      opened = null;
      throw cause;
    });
    return opened;
  };

  return {
    async transact(stores, mode, run) {
      const tx = (await open()).transaction(stores, mode);
      // Resolves to why it aborted: a `run` that throws first leaves nothing to await it.
      const finished = new Promise<Error | null>((resolve) => {
        tx.oncomplete = () => resolve(null);
        tx.onabort = () => resolve(tx.error ?? new DOMException("Aborted", "AbortError"));
      });
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(tx);
      } catch (cause) {
        // An aborted request already aborted the transaction.
        if (!tx.error) tx.abort();
        throw cause;
      }
      const failure = await finished;
      if (failure) throw failure;
      return result;
    },
    close() {
      void opened?.then((db) => db.close());
      opened = null;
    },
  };
}
