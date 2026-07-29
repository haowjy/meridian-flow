/**
 * Putting a runtime value into an attribute selector.
 *
 * `CSS.escape` is the browser primitive, and jsdom does not always expose a
 * global `CSS` — so a query written with it works in the app and throws in the
 * test that covers it. One shared answer with a hand-rolled fallback keeps the
 * query testable everywhere.
 */

export const escapeCssIdent: (value: string) => string =
  globalThis.CSS?.escape ?? ((value) => value.replace(/[^\w-]/g, (character) => `\\${character}`));
