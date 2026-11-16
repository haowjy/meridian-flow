/**
 * Schema-fence state and local quarantine persistence.
 *
 * A fence is orthogonal to connection status: it records why this client must
 * not bind an editable schema to a room whose content it cannot preserve.
 */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { browserStorage, type RecordStorage } from "@/client/storage/browser-record";

export type SchemaFence = {
  reason: "client-superseded";
};

function fenceStorage(): RecordStorage | null {
  try {
    return browserStorage("local");
  } catch {
    return null;
  }
}

export function schemaFenceQuarantineKey(roomKey: string): string {
  return `meridian:schema-fence:${collabSchemaKeyTag()}:${roomKey}`;
}

export function readSchemaFenceQuarantine(roomKey: string): SchemaFence | null {
  const storage = fenceStorage();
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
  const storage = fenceStorage();
  if (!storage) return false;
  try {
    storage.setItem(schemaFenceQuarantineKey(roomKey), JSON.stringify(fence));
    return true;
  } catch {
    return false;
  }
}
