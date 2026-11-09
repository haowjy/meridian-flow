/**
 * Live Yjs connections by the owners (Works and lineages, keyed by `draftOwnerKey`) their file access depends on (file-access
 * §7). A Work's archive, unarchive, delete or restore reaches exactly the rooms
 * of its own files, its scratch and its drafts, and no manuscript, kb or user
 * room. Draft rooms are named by draft id, so room names can't answer this.
 */

/** One admitted connection; `revoke` closes it so the client reconnects. */
export type YjsRoomRegistration = { revoke(): void };

export type YjsRoomAccessIndex = ReturnType<typeof createYjsRoomAccessIndex>;

export function createYjsRoomAccessIndex() {
  const byOwner = new Map<string, Set<YjsRoomRegistration>>();
  const ownersOf = new Map<YjsRoomRegistration, readonly string[]>();

  function unregister(registration: YjsRoomRegistration): void {
    for (const ownerKey of ownersOf.get(registration) ?? []) {
      const registrations = byOwner.get(ownerKey);
      registrations?.delete(registration);
      if (registrations?.size === 0) byOwner.delete(ownerKey);
    }
    ownersOf.delete(registration);
  }

  return {
    register(registration: YjsRoomRegistration, ownerKeys: readonly string[]): void {
      unregister(registration);
      ownersOf.set(registration, ownerKeys);
      for (const ownerKey of ownerKeys) {
        const registrations = byOwner.get(ownerKey) ?? new Set();
        registrations.add(registration);
        byOwner.set(ownerKey, registrations);
      }
    },
    unregister,
    /** Closes every connection whose access this owner decides. */
    revokeOwner(ownerKey: string): void {
      for (const registration of [...(byOwner.get(ownerKey) ?? [])]) {
        unregister(registration);
        registration.revoke();
      }
    },
  };
}
