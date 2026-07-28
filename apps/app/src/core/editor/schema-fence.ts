/**
 * Schema-fence state and local quarantine persistence.
 *
 * A fence is orthogonal to connection status: it records why this client must
 * not bind an editable schema to a room whose content it cannot preserve.
 */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";

export type SchemaFence = {
  reason: "client-superseded";
};

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function clientSchemaReloadGuardKey(roomKey: string): string {
  return `meridian:schema-reload:${collabSchemaKeyTag()}:${roomKey}`;
}

/** Reload only after durably recording the attempt, so a stale bundle cannot loop. */
export function attemptClientSchemaReload(roomKey: string): boolean {
  const storage = browserSessionStorage();
  if (!storage) return false;
  try {
    const key = clientSchemaReloadGuardKey(roomKey);
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, "1");
    globalThis.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function clearClientSchemaReloadGuard(roomKey: string): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(clientSchemaReloadGuardKey(roomKey));
  } catch {
    // A blocked storage backend cannot retain a loop guard either.
  }
}

export function schemaFenceQuarantineKey(roomKey: string): string {
  return `meridian:schema-fence:${collabSchemaKeyTag()}:${roomKey}`;
}

export function readSchemaFenceQuarantine(roomKey: string): SchemaFence | null {
  const storage = browserStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(schemaFenceQuarantineKey(roomKey));
    if (!value) return null;
    const fence = JSON.parse(value) as { reason?: unknown } | null;
    if (fence?.reason !== "client-superseded") return null;
    return { reason: "client-superseded" };
  } catch {
    return null;
  }
}

/** Returns false when browser storage cannot make the fence durable. */
export function writeSchemaFenceQuarantine(roomKey: string, fence: SchemaFence): boolean {
  const storage = browserStorage();
  if (!storage) return false;
  try {
    storage.setItem(schemaFenceQuarantineKey(roomKey), JSON.stringify(fence));
    return true;
  } catch {
    return false;
  }
}
