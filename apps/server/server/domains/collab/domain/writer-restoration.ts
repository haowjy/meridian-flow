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
        let anchored = source.parentSub === null ? sameId(target.rightOrigin, alias.source) : false;
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
          sameParent = completeContainer(sourceParent, targetParent, candidates, after);
          // redoItem traces to siblings that have already been recreated in the
          // new parent, skipping those still in the old parent. Formatting
          // markers can be restored before their preceding text.
          const priorCopy = (item: Y.Item, clock: number): Y.ID | null => {
            const sibling = candidates.find(
              (candidate) =>
                candidate.source.client === item.id.client &&
                candidate.source.clock <= clock &&
                clock < candidate.source.clock + candidate.source.length &&
                candidate.target.client === target.id.client &&
                candidate.target.clock + candidate.target.length <= target.id.clock &&
                itemAt(after, candidate.target.client, candidate.target.clock)?.parent ===
                  targetParent &&
                certify(candidate),
            );
            return sibling
              ? Y.createID(
                  sibling.target.client,
                  sibling.target.clock + clock - sibling.source.clock,
                )
              : null;
          };
          const trace = (item: Y.Item | null, side: "left" | "right"): Y.ID | null => {
            while (item) {
              const id = priorCopy(item, side === "left" ? item.lastId.clock : item.id.clock);
              if (id) return id;
              item = item[side];
            }
            return null;
          };
          anchored =
            source.parentSub === null
              ? sameId(target.origin, trace(source.left, "left")) &&
                sameId(target.rightOrigin, trace(source.right, "right"))
              : sameId(target.origin, trace(source, "right")) && target.rightOrigin === null;
          if (anchored && source.parentSub === null) {
            // Claims are untrusted: an early copy with no anchors must not
            // borrow a later sibling's identity and invert the final order.
            anchored = candidates.every((sibling) => {
              if (sibling === alias) return true;
              const otherSource = itemAt(after, sibling.source.client, sibling.source.clock);
              const otherTarget = itemAt(after, sibling.target.client, sibling.target.clock);
              if (
                !otherSource ||
                !otherTarget ||
                otherSource.parent !== sourceParent ||
                otherTarget.parent !== targetParent ||
                otherSource.parentSub !== null
              )
                return true;
              return sameId(alias.source, sibling.source)
                ? false
                : precedes(source, alias.source.clock, otherSource, sibling.source.clock) ===
                    precedes(target, alias.target.clock, otherTarget, sibling.target.clock);
            });
          }
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

function sameId(left: Y.ID | null, right: { client: number; clock: number } | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.client === right.client && left.clock === right.clock;
}

/** Require a complete bijection of retained source slots and live recreated slots.
 * Selectively omitted browser claims cannot prove where equal-content copies belong.
 */
function completeContainer(
  source: Y.Item["parent"],
  target: Y.Item["parent"],
  aliases: RestorationAlias[],
  doc: Y.Doc,
): boolean {
  if (!(source instanceof Y.AbstractType) || !(target instanceof Y.AbstractType)) return false;
  const pairs = aliases.filter((alias) => {
    const oldItem = itemAt(doc, alias.source.client, alias.source.clock);
    const newItem = itemAt(doc, alias.target.client, alias.target.clock);
    return (
      oldItem?.parent === source &&
      newItem?.parent === target &&
      oldItem?.parentSub === newItem?.parentSub
    );
  });
  const covered = (parent: Y.AbstractType<unknown>, side: "source" | "target") => {
    const items = [...parent._map.values()];
    for (let item = parent._start; item; item = item.right) items.push(item);
    return items
      .filter((item) => side === "source" || !item.deleted)
      .every((item) => {
        const ranges = pairs
          .map((alias) => alias[side])
          .filter((range) => itemAt(doc, range.client, range.clock) === item)
          .sort((a, b) => a.clock - b.clock);
        let clock = item.id.clock;
        for (const range of ranges) {
          if (range.clock !== clock || clock + range.length > item.id.clock + item.length)
            return false;
          clock += range.length;
        }
        return clock === item.id.clock + item.length;
      });
  };
  return covered(source, "source") && covered(target, "target");
}

function precedes(left: Y.Item, leftClock: number, right: Y.Item, rightClock: number): boolean {
  if (left === right) return leftClock < rightClock;
  for (let item = left.right; item; item = item.right) {
    if (item === right) return true;
  }
  return false;
}
