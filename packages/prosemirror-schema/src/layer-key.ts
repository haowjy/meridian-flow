/**
 * A block's pending attribute layers (`sugAttrs`, `@meridian/suggestions`) are stored one Yjs
 * element attribute per layer, `sugAttrs--<layer id>`, so removing one layer deletes that item alone
 * and a new layer writes a key no other write picks. ProseMirror sees them as one attribute, the
 * record of layers by layer id: a schema cannot declare a key per layer, and an undeclared key does
 * not survive the binding. Every conversion between an element and a node folds or expands by this
 * rule. The binding patch (`patches/@tiptap__y-tiptap@3.3.0.patch`) carries its own copy, as it does
 * for `yjsMarkKey`; a change here changes it too.
 */

export const LAYER_PREFIX = "sugAttrs--";

/** The element attribute one layer is stored under. */
export function layerKey(layer: string): string {
  return `${LAYER_PREFIX}${layer}`;
}

export function isLayerKey(key: string): boolean {
  return key.startsWith(LAYER_PREFIX);
}

/** Yjs → ProseMirror: the element's layer keys become the node's `sugAttrs` record, or null. */
export function foldLayers(element: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let layers: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(element)) {
    if (isLayerKey(key)) {
      layers ??= {};
      layers[key.slice(LAYER_PREFIX.length)] = value;
    } else if (key !== "sugAttrs") out[key] = value;
  }
  if (layers) out.sugAttrs = layers;
  return out;
}

/** ProseMirror → Yjs: the node's `sugAttrs` record becomes one key per layer; never a `sugAttrs` key. */
export function expandLayers(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key !== "sugAttrs") out[key] = value;
    else if (value && typeof value === "object")
      for (const [layer, entry] of Object.entries(value)) out[layerKey(layer)] = entry;
  }
  return out;
}

/**
 * What brings an element's layer keys to `layers`: the keys whose value differs by content, and the
 * layer keys the record no longer has. A layer an edit left alone, or copied, writes nothing.
 */
export function layerWrites(
  element: Record<string, unknown>,
  layers: Record<string, unknown> | null | undefined,
): { set: Array<[string, unknown]>; remove: string[] } {
  const wanted = expandLayers({ sugAttrs: layers ?? null });
  const set = Object.entries(wanted).filter(([key, value]) => !sameJSON(element[key], value));
  const remove = Object.keys(element).filter(
    (key) => (isLayerKey(key) && !(key in wanted)) || key === "sugAttrs",
  );
  return { set, remove };
}

/** Plain data compared by content, whatever order its keys were written in. */
export function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) =>
    sameJSON((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
