/**
 * The layout jsdom does not have, for editor tests that press keys.
 *
 * jsdom lays nothing out, so every geometry API answers zero — except on
 * `Range`, where `getClientRects` is not implemented at all. ProseMirror
 * reaches for it whenever a key has to know where the caret physically is:
 * `endOfTextblock` measures the line to decide whether Down leaves the block,
 * which is how gapcursor decides whether to put a cursor beside a table. A test
 * that presses an arrow key therefore throws inside a dependency, as an
 * unhandled error rather than a failed assertion, and the suite reports a
 * passing test file and a non-zero exit.
 *
 * Zeroes are the right answer here: no test that presses a key is asserting
 * about pixels, and the ones that are about geometry stub their own
 * measurements. Same shape as the `document.elementFromPoint` shim the
 * context-menu router's tests already install.
 */

const EMPTY_RECT: DOMRect = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  toJSON: () => ({}),
};

/** Idempotent: only fills in what the environment is actually missing. */
export function installJsdomLayout(): void {
  if (typeof Range !== "undefined") {
    Range.prototype.getClientRects ??= () =>
      Object.assign([], { item: () => null }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect ??= () => EMPTY_RECT;
  }
  if (typeof document !== "undefined") {
    document.elementFromPoint ??= () => null;
  }
}
