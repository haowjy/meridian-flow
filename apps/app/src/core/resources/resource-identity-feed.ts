/** Announces which stored document ids now answer to which current id, once per identity revision. */
import { type ResourceRecord, resourceIdentityIndex } from "@meridian/resource-replica";

/** `from` was this resource's id before an identity change; `to` is the id it answers to now. */
export type ResourceIdentityChange = {
  projectId: string;
  handle: string;
  from: string;
  to: string;
  /** Already true when this account first observed the resource (a replay, not a live change). */
  initial: boolean;
};

export class ResourceIdentityFeed {
  private readonly identityRevisions = new Map<string, number>();
  private readonly latest = new Map<string, ResourceIdentityChange[]>();
  private readonly listeners = new Set<(change: ResourceIdentityChange) => void>();

  /** Replays what is already known, then delivers each change as it is observed. */
  subscribe(listener: (change: ResourceIdentityChange) => void): () => void {
    for (const changes of this.latest.values())
      for (const change of changes) listener({ ...change, initial: true });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * An alias is announced only while its resource owns it: another resource that currently holds
   * the same id is the real document, and stored references to it must stay where they are.
   */
  observe(records: readonly ResourceRecord[]): void {
    const index = resourceIdentityIndex(records);
    for (const record of records) {
      const { handle, identity, aliases } = record.resource;
      const known = this.identityRevisions.get(handle);
      if (known === identity.revision) continue;
      this.identityRevisions.set(handle, identity.revision);
      const projectId = record.intents[0]?.projectId;
      const changes = projectId
        ? Object.keys(aliases)
            .filter((alias) => index.byDocumentId(alias) === record)
            .map((from) => ({
              projectId,
              handle,
              from,
              to: identity.documentId,
              initial: known === undefined,
            }))
        : [];
      if (changes.length) this.latest.set(handle, changes);
      else this.latest.delete(handle);
      for (const change of changes) for (const listener of this.listeners) listener(change);
    }
  }
}
