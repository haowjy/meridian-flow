/**
 * Schema-fence state and local quarantine persistence.
 *
 * A fence is orthogonal to connection status: it records why this client must
 * not bind an editable schema to a room whose content it cannot preserve.
 */
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export type SchemaFence = {
  reason: "client-superseded" | "invalid-content" | "repair-detected";
  /** Machine detail for observability: close reason, failing node name, etc. */
  detail?: string;
};

const SCHEMA_FENCE_REASONS = new Set<SchemaFence["reason"]>([
  "client-superseded",
  "invalid-content",
  "repair-detected",
]);

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
  return `meridian:schema-reload:v${COLLAB_SCHEMA_VERSION}:${roomKey}`;
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
  return `meridian:schema-fence:v${COLLAB_SCHEMA_VERSION}:${roomKey}`;
}

export function readSchemaFenceQuarantine(roomKey: string): SchemaFence | null {
  const storage = browserStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(schemaFenceQuarantineKey(roomKey));
    if (!value) return null;
    const fence = JSON.parse(value) as Partial<SchemaFence>;
    if (!SCHEMA_FENCE_REASONS.has(fence.reason as SchemaFence["reason"])) return null;
    if (fence.detail !== undefined && typeof fence.detail !== "string") return null;
    return {
      reason: fence.reason as SchemaFence["reason"],
      ...(fence.detail !== undefined ? { detail: fence.detail } : {}),
    };
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

export function clearSchemaFenceQuarantine(roomKey: string): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    storage.removeItem(schemaFenceQuarantineKey(roomKey));
  } catch {
    // A blocked storage backend has nothing this session can clear.
  }
}

/** Clone before preview binding because y-prosemirror may repair the document it reads. */
export function cloneDocumentForSchemaFencePreview(source: Y.Doc): Y.Doc {
  const clone = createCollabYDoc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(source));
  return clone;
}
