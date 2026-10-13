/** Durable, untrusted Undo restoration claims; only server-certified journal metadata grants authorship. */
import * as Y from "yjs";

export const RESTORATION_CLAIMS_TYPE = "meridian_restoration_claims";
export type RestorationRange = { client: number; clock: number; length: number };
export type RestorationAlias = { source: RestorationRange; target: RestorationRange };

/** Capture before cleanup merges structs and loses the boundaries of local redone links. */
export function captureUndoRestorationClaims(doc: Y.Doc): () => void {
  const capture = (transaction: Y.Transaction) => {
    if (!transaction.local || !(transaction.origin instanceof Y.UndoManager)) return;
    const aliases: RestorationAlias[] = [];
    for (const structs of doc.store.clients.values()) {
      for (const item of structs) {
        if (!(item instanceof Y.Item) || !item.redone) continue;
        const start = transaction.beforeState.get(item.redone.client) ?? 0;
        const end = transaction.afterState.get(item.redone.client) ?? 0;
        if (item.redone.clock < start || item.redone.clock + item.length > end) continue;
        aliases.push({
          source: { ...item.id, length: item.length },
          target: { ...item.redone, length: item.length },
        });
      }
    }
    if (aliases.length === 0) return;
    // Yjs encodes the outer transaction from beforeState through the current
    // store, including this queued transaction. Thus copies and their claims
    // travel in the same update; the later map-only update is a contained retry.
    doc.transact(() => {
      const claims = doc.getMap<RestorationAlias>(RESTORATION_CLAIMS_TYPE);
      for (const alias of aliases)
        claims.set(`${alias.target.client}:${alias.target.clock}`, alias);
    }, "restoration-claims");
  };
  doc.on("beforeObserverCalls", capture);
  return () => doc.off("beforeObserverCalls", capture);
}

export function restorationAliasesFromMetadata(metadata: unknown): RestorationAlias[] {
  if (!metadata || typeof metadata !== "object" || !("restorationAliases" in metadata)) return [];
  const aliases = metadata.restorationAliases;
  return Array.isArray(aliases) ? aliases.filter(isRestorationAlias) : [];
}

export function isRestorationAlias(value: unknown): value is RestorationAlias {
  if (!value || typeof value !== "object" || !("source" in value) || !("target" in value))
    return false;
  return (
    isRange(value.source) && isRange(value.target) && value.source.length === value.target.length
  );
}

function isRange(value: unknown): value is RestorationRange {
  if (!value || typeof value !== "object") return false;
  const range = value as RestorationRange;
  return (
    Number.isSafeInteger(range.client) &&
    range.client >= 0 &&
    range.client <= 0xffffffff &&
    Number.isSafeInteger(range.clock) &&
    range.clock >= 0 &&
    Number.isSafeInteger(range.length) &&
    range.length > 0 &&
    Number.isSafeInteger(range.clock + range.length)
  );
}
