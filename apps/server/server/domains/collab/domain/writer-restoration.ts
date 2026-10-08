/** Certifies browser restoration claims against retained Yjs tombstones under the admission lock. */
import {
  isRestorationAlias,
  RESTORATION_CLAIMS_TYPE,
  type RestorationAlias,
} from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export function certifyWriterRestorations(before: Y.Doc, update: Uint8Array): RestorationAlias[] {
  // Ordinary keystrokes carry no claims. Avoid another full-document clone on
  // that hot path; only candidate metadata needs tombstone reconstruction.
  const carriesClaim = Y.decodeUpdate(update).structs.some(
    (struct) =>
      struct instanceof Y.Item &&
      struct.content instanceof Y.ContentAny &&
      struct.content.getContent().some(isRestorationAlias),
  );
  if (!carriesClaim) return [];
  const after = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
    const floor = Y.decodeStateVector(Y.encodeStateVector(before));
    Y.applyUpdate(after, update);
    const claims = after.getMap(RESTORATION_CLAIMS_TYPE);
    const candidates: RestorationAlias[] = [];
    for (const [key, alias] of claims.entries()) {
      if (!isRestorationAlias(alias)) continue;
      const claimItem = claims._map.get(key);
      if (!claimItem || claimItem.id.clock < (floor.get(claimItem.id.client) ?? 0)) continue;
      if (alias.target.clock < (floor.get(alias.target.client) ?? 0)) continue;
      candidates.push(alias);
    }
    const verdicts = new Map<RestorationAlias, boolean>();
    const checking = new Set<RestorationAlias>();
    const certify = (alias: RestorationAlias): boolean => {
      const prior = verdicts.get(alias);
      if (prior !== undefined) return prior;
      if (checking.has(alias)) return false;
      checking.add(alias);
      const source = itemAt(after, alias.source.client, alias.source.clock);
      const target = itemAt(after, alias.target.client, alias.target.clock);
      let valid = false;
      if (
        source &&
        target &&
        source.deleted &&
        !target.deleted &&
        target.id.clock === alias.target.clock &&
        source.parentSub === target.parentSub
      ) {
        // List restoration is immediately before its source. Map restoration
        // replaces the retained source at the same key. Neither content nor a
        // matching parent alone proves the copy belongs to that source.
        const anchor = source.parentSub === null ? target.rightOrigin : target.origin;
        let anchored =
          anchor?.client === alias.source.client && anchor.clock === alias.source.clock;
        const sourceParent = source.parent;
        const targetParent = target.parent;
        let sameParent = sourceParent === targetParent;
        if (
          !sameParent &&
          sourceParent instanceof Y.AbstractType &&
          targetParent instanceof Y.AbstractType
        ) {
          const sourceId = sourceParent._item?.id;
          const targetId = targetParent._item?.id;
          sameParent =
            !!sourceId &&
            !!targetId &&
            candidates.some(
              (parent) =>
                parent.source.client === sourceId.client &&
                parent.source.clock === sourceId.clock &&
                parent.target.client === targetId.client &&
                parent.target.clock === targetId.clock &&
                parent.source.length === 1 &&
                certify(parent),
            );
        }
        if (sameParent && sourceParent !== targetParent) {
          // Yjs must drop cross-parent origins when it recreates a deleted
          // container. The certified parent identity is then the anchor; the
          // left sibling must map to the same source slot (never text matching).
          const left = source.left?.lastId;
          anchored =
            target.origin === null
              ? source.parentSub !== null || left === undefined
              : !!left &&
                candidates.some(
                  (sibling) =>
                    sibling.source.client === left.client &&
                    sibling.source.clock <= left.clock &&
                    left.clock < sibling.source.clock + sibling.source.length &&
                    sibling.target.client === target.origin?.client &&
                    sibling.target.clock + left.clock - sibling.source.clock ===
                      target.origin?.clock &&
                    certify(sibling),
                );
        }
        valid = anchored && sameParent && sameContent(source, target, alias);
      }
      checking.delete(alias);
      verdicts.set(alias, valid);
      return valid;
    };
    return candidates.filter(certify);
  } finally {
    after.destroy();
  }
}

function itemAt(doc: Y.Doc, client: number, clock: number): Y.Item | null {
  const structs = doc.store.clients.get(client) ?? [];
  const item = structs.find(
    (struct) => struct.id.clock <= clock && clock < struct.id.clock + struct.length,
  );
  return item instanceof Y.Item ? item : null;
}

function sameContent(source: Y.Item, target: Y.Item, alias: RestorationAlias): boolean {
  const offset = alias.source.clock - source.id.clock;
  if (
    offset + alias.source.length > source.length ||
    alias.target.length > target.length ||
    source.content.getRef() !== target.content.getRef()
  )
    return false;
  if (source.content instanceof Y.ContentType && target.content instanceof Y.ContentType) {
    const left = source.content.type;
    const right = target.content.type;
    return (
      left.constructor === right.constructor &&
      (!(left instanceof Y.XmlElement) ||
        (right instanceof Y.XmlElement && left.nodeName === right.nodeName))
    );
  }
  if (source.content instanceof Y.ContentFormat && target.content instanceof Y.ContentFormat) {
    return (
      source.content.key === target.content.key &&
      JSON.stringify(source.content.value) === JSON.stringify(target.content.value)
    );
  }
  if (source.content instanceof Y.ContentString && target.content instanceof Y.ContentString) {
    return (
      source.content.str.slice(offset, offset + alias.source.length) ===
      target.content.str.slice(0, alias.target.length)
    );
  }
  return (
    JSON.stringify(source.content.getContent().slice(offset, offset + alias.source.length)) ===
    JSON.stringify(target.content.getContent().slice(0, alias.target.length))
  );
}
