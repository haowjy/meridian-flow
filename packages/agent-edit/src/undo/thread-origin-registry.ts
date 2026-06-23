// Provides stable Yjs transaction origins for agent writes by document/thread.

/** Registry keyed by (docId, threadId), with stable Symbol origins per key. */
export class ThreadOriginRegistry {
  private readonly origins = new Map<string, symbol>();

  getThreadOrigin(docId: string, threadId: string): symbol {
    const key = originKey(docId, threadId);
    let origin = this.origins.get(key);
    if (!origin) {
      origin = Symbol(`thread-${threadId}`);
      this.origins.set(key, origin);
    }
    return origin;
  }

  evictThread(docId: string, threadId: string): boolean {
    return this.origins.delete(originKey(docId, threadId));
  }
}

export function createThreadOriginRegistry(): ThreadOriginRegistry {
  return new ThreadOriginRegistry();
}

function originKey(docId: string, threadId: string): string {
  return `${docId}\u0000${threadId}`;
}
