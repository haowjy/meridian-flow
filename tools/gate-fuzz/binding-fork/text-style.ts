import type { Loro, Value } from "loro-crdt";
import type { Attrs, Mark, Schema } from "prosemirror-model";

const LORO_TEXT_STYLE_CACHE = new WeakSet<Loro>();

/**
 * The `comment` mark is stored as one Loro style key per comment, `comment_<id>`, so a writer's
 * and the AI's comments on the same words are two keys instead of one overwriting the other.
 */
const COMMENT_MARK = "comment";
const COMMENT_KEY_PREFIX = "comment_";

/** The Loro style key (text) or `marks` map key (inline node) a ProseMirror mark is stored under. */
export function markKey(mark: Mark): string {
  if (mark.type.name === COMMENT_MARK && mark.attrs.id != null) {
    return COMMENT_KEY_PREFIX + String(mark.attrs.id);
  }
  return mark.type.name;
}

/** The value stored under `markKey(mark)`: a comment's id is in its key, so its value is `true`. */
export function markValue(mark: Mark): Value | Attrs {
  return isCommentKey(mark.type.schema, markKey(mark)) ? true : mark.attrs;
}

/** The ProseMirror mark a stored key and value stand for. Throws for a key the schema can't build. */
export function markFromStored(schema: Schema, key: string, value: unknown): Mark {
  if (isCommentKey(schema, key)) {
    return schema.marks[COMMENT_MARK].create({ id: key.slice(COMMENT_KEY_PREFIX.length) });
  }
  return schema.mark(key, valueToAttrs(value) ?? undefined);
}

export function marksToStored(marks: readonly Mark[]): { [key: string]: Value | Attrs } {
  const stored: { [key: string]: Value | Attrs } = {};
  for (const mark of marks) stored[markKey(mark)] = markValue(mark);
  return stored;
}

function isCommentKey(schema: Schema, key: string): boolean {
  return key.startsWith(COMMENT_KEY_PREFIX) && schema.marks[COMMENT_MARK] != null;
}

export function valueToAttrs(value: unknown): Attrs | null {
  if (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    return value as Attrs;
  }
  return null;
}

function getLoroTextStyle(schema: Schema): {
  [mark: string]: { expand: "before" | "after" | "none" | "both" };
} {
  return Object.fromEntries(
    Object.entries(schema.marks)
      .filter(([markName]) => markName !== COMMENT_MARK)
      .map(([markName, markType]) => [
        markName,
        // ProseMirror marks are inclusive unless the spec says otherwise, so
        // only an explicit `inclusive: false` should map to "none".
        { expand: markType.spec.inclusive !== false ? "after" : "none" },
      ]),
  );
}

/**
 * Configure the schema's marks as Loro text styles. Every peer that writes marks (each tab, the
 * server) must call this before its first mark: Loro keeps the config per peer, not in the document.
 * The `comment_<id>` keys can't be listed ahead, so they take the default, which is `none`
 * (a comment never grows by typing at its edge, as `inclusive: false` says).
 */
export function configLoroTextStyle(doc: Loro, schema: Schema) {
  // Avoid reconfiguring the text style for the same Loro document.
  if (LORO_TEXT_STYLE_CACHE.has(doc)) {
    return;
  }
  LORO_TEXT_STYLE_CACHE.add(doc);

  doc.configTextStyle(getLoroTextStyle(schema));
  doc.configDefaultTextStyle({ expand: "none" });
}
