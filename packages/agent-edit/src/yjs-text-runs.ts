/**
 * Adjacent `Y.XmlText` children of a block are one run of text: two peers that type into
 * the same empty paragraph at once leave two texts there, and nothing merges them. The
 * patched `@tiptap/y-tiptap` binding reads and writes them as one run; this is the same
 * rule for our own writers. An edit goes to the text that owns its offset, an insert at a
 * boundary goes left, and a text is only emptied, never deleted, because a peer's
 * concurrent insert may be anchored in it. Imports only Yjs.
 */
import type * as Y from "yjs";

type Attrs = Record<string, unknown>;

/** The `Y.Text` calls the writers use, over a run's texts as if they were one. */
export class TextRun {
  constructor(readonly texts: readonly Y.XmlText[]) {
    if (texts.length === 0) throw new RangeError("A text run needs at least one text");
  }

  get length(): number {
    return this.texts.reduce((sum, text) => sum + text.length, 0);
  }

  toDelta(): Array<{ insert: string; attributes?: Attrs }> {
    return this.texts.flatMap(
      (text) => text.toDelta() as Array<{ insert: string; attributes?: Attrs }>,
    );
  }

  insert(offset: number, value: string, attrs?: Attrs): void {
    let start = 0;
    for (const text of this.texts) {
      if (offset <= start + text.length) {
        text.insert(offset - start, value, attrs);
        return;
      }
      start += text.length;
    }
    throw new RangeError(`Offset ${offset} is outside a run of ${start}`);
  }

  delete(from: number, length: number): void {
    this.each(from, from + length, (text, at, count) => text.delete(at, count));
  }

  format(from: number, length: number, attrs: Attrs): void {
    this.each(from, from + length, (text, at, count) => text.format(at, count, attrs));
  }

  private each(
    from: number,
    to: number,
    apply: (text: Y.XmlText, at: number, count: number) => void,
  ) {
    let start = 0;
    for (const text of this.texts) {
      const length = text.length;
      const lo = Math.max(from, start);
      const hi = Math.min(to, start + length);
      if (lo < hi) apply(text, lo - start, hi - lo);
      start += length;
    }
  }
}
