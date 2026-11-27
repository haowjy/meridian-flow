import type { Delta, LoroDoc, LoroText } from "loro-crdt";
import { inText } from "./handles.js";
import { normalizeMarks, shownUnits, type TextUnit, textUnits } from "./read.js";
import {
  INLINE_STYLE,
  type InlineItem,
  type NodeRule,
  SENTINEL,
  type ShapeSchema,
  sameValue,
} from "./shape.js";

export interface TextRules {
  rule: NodeRule;
  shape: ShapeSchema;
  visibleComment: (comment: string) => boolean;
}

export interface WantedUnit {
  ch: string;
  style: Readonly<Record<string, unknown>>;
}

export function wantedUnits(items: readonly InlineItem[]): WantedUnit[] {
  const out: WantedUnit[] = [];
  for (const item of items) {
    if (item.kind === "inline")
      out.push({
        ch: SENTINEL,
        style: { ...item.marks, [INLINE_STYLE]: { type: item.node, attrs: item.attrs } },
      });
    else
      for (let i = 0; i < item.text.length; i++) out.push({ ch: item.text[i], style: item.marks });
  }
  return out;
}

export function replaceText(
  doc: LoroDoc,
  rules: TextRules,
  from: number,
  to: number,
  items: readonly InlineItem[],
): void {
  replaceUnits(doc, rules, from, to, wantedUnits(items));
}

export function replaceUnits(
  doc: LoroDoc,
  rules: TextRules,
  from: number,
  to: number,
  wanted: readonly WantedUnit[],
): void {
  inText(doc, (text) => {
    let shown = shownUnits(doc, rules.rule, rules.shape);
    const removed = shown.slice(from, to).map((unit) => unit.pos);
    for (let end = removed.length; end > 0; ) {
      let start = end - 1;
      while (start > 0 && removed[start - 1] === removed[start] - 1) start--;
      text.delete(removed[start], removed[end - 1] - removed[start] + 1);
      end = start;
    }
    if (wanted.length === 0) return;
    if (removed.length > 0) shown = shownUnits(doc, rules.rule, rules.shape);
    const at = from < shown.length ? shown[from].pos : text.length;
    text.insert(at, wanted.map((unit) => unit.ch).join(""));
    const inserted = textUnits(doc, rules.rule, rules.shape).slice(at, at + wanted.length);
    patchStyles(text, inserted, wanted, rules);
  });
}

export function patchStyles(
  text: LoroText,
  units: readonly TextUnit[],
  wanted: readonly WantedUnit[],
  rules: TextRules,
): void {
  const delta: Delta<string>[] = [];
  let cursor = 0;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.ch !== wanted[i]?.ch) throw new Error("text differs from the wanted text");
    const patch = stylePatch(unit, wanted[i].style, rules);
    if (!patch) continue;
    const last = delta.at(-1);
    if (last?.attributes && cursor === unit.pos && sameValue(last.attributes, patch))
      (last as { retain: number }).retain += 1;
    else {
      if (unit.pos > cursor) delta.push({ retain: unit.pos - cursor } as Delta<string>);
      delta.push({ retain: 1, attributes: patch } as Delta<string>);
    }
    cursor = unit.pos + 1;
  }
  if (delta.length > 0) text.applyDelta(delta);
}

/**
 * The style changes that make `unit` read as `want`: set what is stored differently, then clear
 * every key that would show and is not wanted, including one the normalizer hid until now (stored
 * `{code, strong}` written as plain clears both, or it would read `strong`). A key that stays
 * hidden (a comment whose body this reader cannot see) is left alone.
 */
function stylePatch(
  unit: TextUnit,
  want: Readonly<Record<string, unknown>>,
  { rule, shape, visibleComment }: TextRules,
): Record<string, unknown> | null {
  const stored: Record<string, unknown> = { ...unit.stored };
  if (unit.inline) stored[INLINE_STYLE] = { type: unit.inline.node, attrs: unit.inline.attrs };
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(want))
    if (!sameValue(stored[key], value)) patch[key] = value;
  if (unit.inline && !(INLINE_STYLE in want)) patch[INLINE_STYLE] = null;
  for (let cleared = true; cleared; ) {
    cleared = false;
    for (const key of Object.keys(
      normalizeMarks({ ...stored, ...patch }, rule, shape, visibleComment),
    ))
      if (!(key in want)) {
        patch[key] = null;
        cleared = true;
      }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
