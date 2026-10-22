/** Announces each projection to its readers and each live identity change to its listeners. */
import { type ResourceRecord, resourceIdentityIndex } from "@meridian/resource-replica";

/** `from` was this resource's id before an identity change; `to` is the id it answers to now. */
export type ResourceIdentityChange = {
  projectId: string;
  handle: string;
  from: string;
  to: string;
};

export class ResourceIdentityFeed {
  private readonly identityRevisions = new Map<string, number>();
  private readonly listeners = new Set<(change: ResourceIdentityChange) => void>();
  private readonly projectionListeners = new Set<(records: readonly ResourceRecord[]) => void>();
  private projection: readonly ResourceRecord[] | null = null;

  /** Delivers each change observed from now on; a change already seen is not replayed. */
  subscribe(listener: (change: ResourceIdentityChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The current projection now, and every later one. Readers resolve ids against it, not history. */
  subscribeProjection(listener: (records: readonly ResourceRecord[]) => void): () => void {
    if (this.projection) listener(this.projection);
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  /**
   * An alias is announced only while its resource owns it: another resource that currently holds
   * the same id is the real document, and stored references to it must stay where they are.
   */
  observe(records: readonly ResourceRecord[]): void {
    this.projection = records;
    const index = resourceIdentityIndex(records);
    for (const record of records) {
      const { handle, identity, aliases } = record.resource;
      const known = this.identityRevisions.get(handle);
      if (known === identity.revision) continue;
      this.identityRevisions.set(handle, identity.revision);
      const projectId = record.intents[0]?.projectId;
      if (known === undefined || !projectId) continue;
      for (const from of Object.keys(aliases))
        if (index.byDocumentId(from) === record)
          for (const listener of this.listeners)
            listener({ projectId, handle, from, to: identity.documentId });
    }
    for (const listener of this.projectionListeners) listener(records);
  }
}
