import type { LoroDoc, LoroMap, LoroText } from "loro-crdt";
import { TEXT_KEY } from "./shape.js";

/**
 * Loro hands out a WASM handle for every container and cursor a call returns, and WASM memory is
 * never garbage collected: unfreed handles grow it without bound (2M unfreed reads grew it by
 * 470 MB). Use a handle inside `scoped` or one of these (for versions, `version.ts`), and never
 * keep one past the call that made it.
 */
export function scoped<H extends { free(): void }, T>(handle: H, use: (handle: H) => T): T {
  try {
    return use(handle);
  } finally {
    handle.free();
  }
}

export function inText<T>(doc: LoroDoc, use: (text: LoroText) => T): T {
  return scoped(doc.getText(TEXT_KEY), use);
}

export function inMap<T>(doc: LoroDoc, name: string, use: (map: LoroMap) => T): T {
  return scoped(doc.getMap(name), use);
}
