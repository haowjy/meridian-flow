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

export function schemaFenceQuarantineKey(roomKey: string): string {
  return `meridian:schema-fence:v${COLLAB_SCHEMA_VERSION}:${roomKey}`;
}

export function readSchemaFenceQuarantine(roomKey: string): SchemaFence | null {
  if (typeof localStorage === "undefined") return null;

  try {
    const value = localStorage.getItem(schemaFenceQuarantineKey(roomKey));
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
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(schemaFenceQuarantineKey(roomKey), JSON.stringify(fence));
    return true;
  } catch {
    return false;
  }
}

export function clearSchemaFenceQuarantine(roomKey: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(schemaFenceQuarantineKey(roomKey));
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
