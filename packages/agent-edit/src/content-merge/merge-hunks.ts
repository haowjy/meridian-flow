import { Mark } from "prosemirror-model";
import type { Hunk } from "../diff/hunks.js";
import { coreKey, isBlockTok, isWordTok, type Tok } from "../diff/tokens.js";

export const BASE = 0;
export const LIVE = 1;
export const DRAFT = 2;
export type Origin = typeof BASE | typeof LIVE | typeof DRAFT;

export interface MergedTok {
  tok: Tok;
  origin: Origin;
  index: number;
}

type TextTok = Extract<Tok, { kind: "text" }>;

export type Touch = "overlap" | "typed-at-end-of-deleted";

export function touch(x: Hunk, y: Hunk, baseToks: Tok[]): Touch | null {
  const xIsInsert = x.from === x.to;
  const yIsInsert = y.from === y.to;
  if (xIsInsert && yIsInsert ? x.from === y.from : false) return "overlap";
  if (xIsInsert && !yIsInsert && y.from < x.from && x.from < y.to) return "overlap";
  if (yIsInsert && !xIsInsert && x.from < y.from && y.from < x.to) return "overlap";
  if (!xIsInsert && !yIsInsert && x.from < y.to && y.from < x.to) return "overlap";
  if (typedAtEndOfDeleted(x, y, baseToks) || typedAtEndOfDeleted(y, x, baseToks))
    return "typed-at-end-of-deleted";
  return null;
}

function typedAtEndOfDeleted(insert: Hunk, deletion: Hunk, baseToks: Tok[]): boolean {
  if (
    insert.from !== insert.to ||
    insert.from !== deletion.to ||
    deletion.to === deletion.from ||
    !insert.ins.length ||
    isBlockTok(insert.ins[0])
  )
    return false;
  let host = insert.from - 1;
  while (host > 0 && !isBlockTok(baseToks[host])) host--;
  return deletion.from <= host && !deletion.ins.some(isBlockTok);
}

export function applyWithin(
  baseToks: Tok[],
  from: number,
  to: number,
  hunks: Hunk[],
  origin: Origin,
): MergedTok[] {
  const out: MergedTok[] = [];
  let at = from;
  for (const h of hunks) {
    for (let i = at; i < h.from; i++) out.push({ tok: baseToks[i], origin: BASE, index: i });
    for (const [k, tok] of h.ins.entries())
      out.push({ tok, origin, index: h.sidx?.[k] ?? h.sfrom + k });
    at = h.to;
  }
  for (let i = at; i < to; i++) out.push({ tok: baseToks[i], origin: BASE, index: i });
  return out;
}

export const sameTokens = (a: readonly MergedTok[], b: readonly MergedTok[]) =>
  a.length === b.length && a.every((o, i) => o.tok.key === b[i].tok.key);

export function isSubsequence(a: readonly MergedTok[], b: readonly MergedTok[]): boolean {
  let i = 0;
  for (const o of b) if (i < a.length && a[i].tok.key === o.tok.key) i++;
  return i === a.length;
}

function absorbs(version: MergedTok[], hunks: Hunk[], baseToks: Tok[]): boolean {
  const keptBase = new Set(version.filter((o) => o.origin === BASE).map((o) => o.index));
  const deleted = new Set<string>();
  for (const h of hunks)
    for (let i = h.from; i < h.to; i++) {
      if (keptBase.has(i)) return false;
      deleted.add(coreKey(baseToks[i]));
    }
  const reinserted = version.some(
    (o) =>
      o.origin !== BASE &&
      deleted.has(coreKey(o.tok)) &&
      !hunks.some((h) => h.ins.some((t) => t.key === o.tok.key)),
  );
  if (reinserted) return false;
  // Each insertion must appear between the same kept base tokens it was inserted between.
  for (const h of hunks) {
    if (!h.ins.length) continue;
    let lo = -1;
    let hi = version.length;
    version.forEach((o, k) => {
      if (o.origin !== BASE) return;
      if (o.index < h.from) lo = k;
      else if (o.index >= h.to && hi === version.length) hi = k;
    });
    let k = lo + 1;
    for (const t of h.ins) {
      while (k < hi && (version[k].origin === BASE || version[k].tok.key !== t.key)) k++;
      if (k >= hi) return false;
      k++;
    }
  }
  return true;
}

/**
 * The draft's text for a window both sides changed, when it already carries live's change there (no
 * conflict). Live's text never wins this way: a live version that seems to contain the draft's change
 * can still have rewritten what the draft deleted, and the draft's text is the conflict default anyway.
 */
export function draftAbsorbsLive(
  liveVersion: MergedTok[],
  draftVersion: MergedTok[],
  liveHunks: Hunk[],
  baseToks: Tok[],
): MergedTok[] | null {
  // A paragraph start that live removed (a join) and the draft retyped (a type change) is still
  // there in the draft: same paragraph count or it isn't absorbed.
  const paragraphStarts = (v: MergedTok[]) => v.filter((o) => isBlockTok(o.tok)).length;
  if (paragraphStarts(liveVersion) !== paragraphStarts(draftVersion)) return null;
  return absorbs(draftVersion, liveHunks, baseToks) ? draftVersion : null;
}

/**
 * Where one side inserts text at a boundary of the other side's replacement, and the
 * replacement's new text shares that edge, split that shared part off as a plain insertion, so
 * it merges as one insertion and only the rest can conflict (`shared-edge-kept-once`). Punctuation
 * alone is not a shared edge: two sentences that both end in "." are two sentences. Returns how many
 * hunks it split.
 */
export function peel(liveHunks: Hunk[], draftHunks: Hunk[]): number {
  let peeled = 0;
  const part = (h: Hunk, a: number, b: number, from: number, to: number): Hunk => ({
    ...h,
    from,
    to,
    sfrom: a === 0 ? h.sfrom : (h.sidx?.[a] ?? h.sfrom + a),
    sto: b === h.ins.length ? h.sto : (h.sidx?.[b] ?? h.sfrom + b),
    ins: h.ins.slice(a, b),
    ...(h.sidx ? { sidx: h.sidx.slice(a, b) } : {}),
  });
  const withinBlock = (y: Hunk) => y.ins.length > 0 && !y.ins.some(isBlockTok);
  for (const [own, other] of [
    [liveHunks, draftHunks],
    [draftHunks, liveHunks],
  ] as const) {
    for (let i = 0; i < own.length; i++) {
      const hunk = own[i];
      if (hunk.from === hunk.to || !withinBlock(hunk)) continue;
      const insertion = other.find(
        (y) => y.from === hunk.from && y.to === hunk.from && withinBlock(y),
      );
      if (insertion && !own.some((x) => x !== hunk && x.from === hunk.from && x.to === hunk.from)) {
        let shared = 0;
        while (
          shared < hunk.ins.length &&
          shared < insertion.ins.length &&
          coreKey(hunk.ins[shared]) === coreKey(insertion.ins[shared])
        )
          shared++;
        if (shared > 0 && hunk.ins.slice(0, shared).some(isWordTok)) {
          own.splice(
            i,
            1,
            part(hunk, 0, shared, hunk.from, hunk.from),
            part(hunk, shared, hunk.ins.length, hunk.from, hunk.to),
          );
          peeled++;
          continue;
        }
      }
      const suffix = other.find((y) => y.from === hunk.to && y.to === hunk.to && withinBlock(y));
      if (!suffix || own.some((x) => x !== hunk && x.from === hunk.to && x.to === hunk.to))
        continue;
      let shared = 0;
      while (
        shared < hunk.ins.length &&
        shared < suffix.ins.length &&
        coreKey(hunk.ins[hunk.ins.length - 1 - shared]) ===
          coreKey(suffix.ins[suffix.ins.length - 1 - shared])
      )
        shared++;
      if (shared > 0 && hunk.ins.slice(hunk.ins.length - shared).some(isWordTok)) {
        const cut = hunk.ins.length - shared;
        own.splice(
          i,
          1,
          part(hunk, 0, cut, hunk.from, hunk.to),
          part(hunk, cut, hunk.ins.length, hunk.to, hunk.to),
        );
        peeled++;
      }
    }
  }
  return peeled;
}

export function mergeMarks(
  baseToks: Tok[],
  liveHunks: Hunk[],
  draftHunks: Hunk[],
): MergedTok | null {
  if (liveHunks.length !== 1 || draftHunks.length !== 1) return null;
  const [live, draft] = [liveHunks[0], draftHunks[0]];
  if (
    live.from !== draft.from ||
    live.to !== live.from + 1 ||
    draft.to !== draft.from + 1 ||
    live.ins.length !== 1 ||
    draft.ins.length !== 1
  )
    return null;
  const base = baseToks[live.from];
  const liveTok = live.ins[0];
  const draftTok = draft.ins[0];
  if (
    base.kind !== "text" ||
    liveTok.kind !== "text" ||
    draftTok.kind !== "text" ||
    liveTok.core !== base.core ||
    draftTok.core !== base.core
  )
    return null;
  const markKey = (m: Mark) => JSON.stringify(m.toJSON());
  const allMarks = new Map<string, Mark>();
  for (const m of [...base.marks, ...liveTok.marks, ...draftTok.marks]) allMarks.set(markKey(m), m);
  const has = (marks: readonly Mark[], key: string) => marks.some((m) => markKey(m) === key);
  const merged: Mark[] = [];
  for (const [key, mark] of allMarks) {
    const [inBase, inLive, inDraft] = [
      has(base.marks, key),
      has(liveTok.marks, key),
      has(draftTok.marks, key),
    ];
    if (inLive === inBase ? inDraft : inDraft === inBase ? inLive : inDraft) merged.push(mark);
  }
  const sorted = Mark.setFrom(merged) as Mark[];
  const marksKey = sorted.length ? JSON.stringify(sorted.map((m) => m.toJSON())) : "";
  const tok: TextTok = {
    kind: "text",
    key: `T${marksKey}\u0001${base.core}`,
    ws: draftTok.ws,
    core: base.core,
    word: base.word,
    marks: sorted,
  };
  return { tok, origin: DRAFT, index: draft.sfrom };
}

export interface MovedText {
  source: number[];
  dropped: Tok[];
  destination: number[];
}

/**
 * Live cut text and pasted it elsewhere, and the draft changed the text where it was cut from. The
 * draft's change wins at the source; pasting live's old copy too would silently undo it, so the
 * paste is left out and shows in review as live text the draft lacks. With `reportOnly` the hunks
 * are left alone and the pastes are only listed (the draft's side of the same rule).
 */
export function dropMovedText(
  baseToks: Tok[],
  liveHunks: Hunk[],
  draftHunks: Hunk[],
  reportOnly = false,
): MovedText[] {
  const isContent = (t: Tok) => t.kind !== "block";
  const deleted: number[] = [];
  // Select from every deletion before checking whether the draft touched the winner's source.
  // Filtering first changes longest-run ties and can silently drop moved words.
  for (const h of liveHunks)
    for (let i = h.from; i < h.to; i++) if (isContent(baseToks[i])) deleted.push(i);
  if (!deleted.length) return [];
  const positions = new Map<string, number[]>();
  for (const [index, source] of deleted.entries()) {
    const key = baseToks[source].key;
    const matches = positions.get(key);
    if (matches) matches.push(index);
    else positions.set(key, [index]);
  }
  const draftTouches = (i: number) => draftHunks.some((h) => h.from <= i && i < h.to);
  const out: MovedText[] = [];
  for (const h of liveHunks) {
    const inserted = h.ins.map((t, k) => [t, k] as const).filter(([t]) => isContent(t));
    if (!inserted.length) continue;
    let best = { len: 0, insAt: 0, delAt: 0 };
    for (let insAt = 0; insAt < inserted.length - best.len; insAt++)
      for (const delAt of positions.get(inserted[insAt][0].key) ?? []) {
        if (deleted.length - delAt <= best.len) break;
        // Extend each matching diagonal only from its start, not again at every suffix.
        // Ascending seed order preserves the first-inserted, first-deleted tie rule.
        if (
          insAt > 0 &&
          delAt > 0 &&
          inserted[insAt - 1][0].key === baseToks[deleted[delAt - 1]].key
        )
          continue;
        let n = 0;
        while (
          insAt + n < inserted.length &&
          delAt + n < deleted.length &&
          inserted[insAt + n][0].key === baseToks[deleted[delAt + n]].key
        )
          n++;
        if (n > best.len) best = { len: n, insAt, delAt };
      }
    if (!best.len) continue;
    const run = inserted.slice(best.insAt, best.insAt + best.len);
    const words = run.filter(([t]) => isWordTok(t)).length;
    const wholeInsert = best.len === inserted.length;
    if (words < 3 && !(wholeInsert && words >= 1)) continue;
    const source = deleted.slice(best.delAt, best.delAt + best.len);
    const typedInside = draftHunks.some(
      (g) =>
        g.from === g.to &&
        g.ins.length &&
        source[0] < g.from &&
        g.from <= source[source.length - 1],
    );
    if (!source.some(draftTouches) && !typedInside) continue;
    const runKeys = run.map(([t]) => t.key).join("\u0002");
    const draftPastedIt = draftHunks.some((g) =>
      g.ins
        .filter(isContent)
        .map((t) => t.key)
        .join("\u0002")
        .includes(runKeys),
    );
    if (draftPastedIt) continue;
    const droppedAt = new Set(run.map(([, k]) => k));
    out.push({
      source,
      dropped: run.map(([t]) => t),
      destination: run.map(([, k]) => h.sidx?.[k] ?? h.sfrom + k),
    });
    if (reportOnly) continue;
    // Keep any paragraph start that only held the pasted text from becoming an empty paragraph.
    const keep = h.ins.map((_, k) => k).filter((k) => !droppedAt.has(k));
    const empty = keep.length === 1 && h.ins[keep[0]].kind === "block" && wholeInsert;
    h.sidx = empty ? [] : keep.map((k) => h.sidx?.[k] ?? h.sfrom + k);
    h.ins = empty ? [] : keep.map((k) => h.ins[k]);
  }
  return out;
}
