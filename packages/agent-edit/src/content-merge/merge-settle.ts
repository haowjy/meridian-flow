import type { Mark } from "prosemirror-model";
import { coreKey, isBlockTok, isWordTok, SPACELESS, type Tok } from "../diff/tokens.js";
import { equalOrderedMatches } from "../ordered-matching.js";
import { BASE, DRAFT, isSubsequence, LIVE, type MergedTok, type Origin } from "./merge-hunks.js";
import type { Fire } from "./rules.js";

function sharedTokens(live: MergedTok[], draft: MergedTok[]) {
  const all = equalOrderedMatches(
    live.map((o) => coreKey(o.tok)),
    draft.map((o) => coreKey(o.tok)),
  );
  const keep = all.map(([mi]) => isWordTok(live[mi].tok));
  const next = (k: number) => all[k + 1]?.[0] === all[k][0] + 1 && all[k + 1][1] === all[k][1] + 1;
  for (let k = 0; k + 1 < all.length; k++) if (next(k) && keep[k]) keep[k + 1] = true;
  for (let k = all.length - 2; k >= 0; k--) if (next(k) && keep[k + 1]) keep[k] = true;
  return all.filter((_, k) => keep[k]);
}

function unionWords(live: MergedTok[], draft: MergedTok[]): MergedTok[] {
  const matches = sharedTokens(live, draft);
  const out: MergedTok[] = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of [...matches, [live.length, draft.length] as const]) {
    out.push(...live.slice(i, mi), ...draft.slice(j, mj));
    if (mi < live.length) out.push(draft[mj]);
    i = mi + 1;
    j = mj + 1;
  }
  return out;
}

function splitParagraphs(run: MergedTok[]): { inline: MergedTok[]; paragraphs: MergedTok[][] } {
  const first = run.findIndex((o) => isBlockTok(o.tok));
  if (first < 0) return { inline: run, paragraphs: [] };
  const paragraphs: MergedTok[][] = [];
  for (const o of run.slice(first)) {
    const current = paragraphs.at(-1);
    if (current && !isBlockTok(o.tok)) current.push(o);
    else paragraphs.push([o]);
  }
  return { inline: run.slice(0, first), paragraphs };
}

export function isOneTextTwice(live: MergedTok[], draft: MergedTok[]): boolean {
  const { inline: liveInline } = splitParagraphs(live);
  const { inline: draftInline } = splitParagraphs(draft);
  const shared = sharedTokens(liveInline, draftInline).filter(([mi]) =>
    isWordTok(liveInline[mi].tok),
  ).length;
  const own = (run: MergedTok[]) => run.filter((o) => isWordTok(o.tok)).length - shared;
  return [own(liveInline), own(draftInline)].every((n) => n > 0 && n < shared);
}

export function unionInsertions(live: MergedTok[], draft: MergedTok[], fire: Fire): MergedTok[] {
  fire("insertions-kept-both");
  if (isSubsequence(live, draft)) return draft;
  if (isSubsequence(draft, live)) return live;
  const { inline: liveInline, paragraphs: liveParagraphs } = splitParagraphs(live);
  const { inline: draftInline, paragraphs: draftParagraphs } = splitParagraphs(draft);
  const inline = isSubsequence(liveInline, draftInline)
    ? draftInline
    : isSubsequence(draftInline, liveInline)
      ? liveInline
      : unionWords(liveInline, draftInline);

  const paragraphKey = (p: MergedTok[]) => p.map((o) => o.tok.key).join("\u0002");
  const out: MergedTok[] = [...inline];
  let i = 0;
  let j = 0;
  for (const [mi, mj] of equalOrderedMatches(
    liveParagraphs.map(paragraphKey),
    draftParagraphs.map(paragraphKey),
  )) {
    for (const p of liveParagraphs.slice(i, mi)) out.push(...p);
    for (const p of draftParagraphs.slice(j, mj)) out.push(...p);
    out.push(...draftParagraphs[mj]);
    i = mi + 1;
    j = mj + 1;
  }
  for (const p of liveParagraphs.slice(i)) out.push(...p);
  for (const p of draftParagraphs.slice(j)) out.push(...p);
  return out;
}

const needsSpace = (prev: Tok, next: Tok) =>
  isWordTok(next) &&
  (isWordTok(prev) || (prev.kind === "text" && /[.!?\u2026,;:]$/.test(prev.core))) &&
  !(prev.kind === "text" && SPACELESS.test(prev.core.at(-1) ?? "")) &&
  !(next.kind === "text" && SPACELESS.test(next.core[0] ?? ""));

type TextTok = Extract<Tok, { kind: "text" }>;

const whitespaceKey = (t: TextTok | null) =>
  t === null
    ? null
    : `${t.ws}\u0001${t.wsMarks ? JSON.stringify(t.wsMarks.map((m) => m.toJSON())) : ""}`;

export function settleWhitespace(
  merged: MergedTok[],
  docs: { base: Tok[]; live: Tok[]; draft: Tok[] },
  baseToLive: Int32Array,
  baseToDraft: Int32Array,
  fire: Fire,
): Tok[] {
  const toksOf = [docs.base, docs.live, docs.draft];
  const indexIn = (o: MergedTok, doc: Origin) => {
    if (o.origin === doc) return o.index;
    if (o.origin !== BASE) return -1;
    return doc === LIVE ? baseToLive[o.index] : baseToDraft[o.index];
  };
  const result: Tok[] = [];
  for (let k = 0; k < merged.length; k++) {
    const current = merged[k];
    if (current.tok.kind !== "text") {
      result.push(current.tok);
      continue;
    }
    const tok = current.tok;
    const pred = k > 0 ? merged[k - 1] : null;
    const atStart = !pred || isBlockTok(pred.tok);
    const neighbours = ([BASE, LIVE, DRAFT] as const).map((doc): TextTok | null => {
      const toks = toksOf[doc];
      const at = indexIn(current, doc);
      if (at < 0) return null;
      const adjacent = atStart
        ? at === 0 || isBlockTok(toks[at - 1])
        : pred !== null && indexIn(pred, doc) === at - 1 && at > 0;
      return adjacent ? (toks[at] as TextTok) : null;
    });
    const [baseKey, liveKey, draftKey] = neighbours.map(whitespaceKey);
    const [baseTok, liveTok, draftTok] = neighbours;
    let from: TextTok | null;
    if (liveKey !== null && draftKey !== null) {
      if (liveKey === baseKey) from = draftTok;
      else if (draftKey === baseKey) from = liveTok;
      else {
        from = draftTok;
        if (liveKey !== draftKey) fire("draft-wins-space");
      }
    } else if (liveKey !== null) from = liveTok;
    else if (draftKey !== null) from = draftTok;
    else from = baseTok;

    let ws: string;
    let wsMarks: readonly Mark[] | undefined;
    if (from) {
      ws = from.ws;
      wsMarks = from.wsMarks;
    } else if (atStart || !pred) ws = "";
    else {
      ws = tok.ws || (needsSpace(pred.tok, tok) ? " " : "");
      if (!tok.ws && ws) fire("space-added-between-words");
      wsMarks = tok.ws ? tok.wsMarks : undefined;
    }
    if (ws === tok.ws && wsMarks === tok.wsMarks) result.push(tok);
    else {
      const settled: TextTok = { ...tok, ws };
      if (wsMarks) settled.wsMarks = wsMarks;
      else delete settled.wsMarks;
      result.push(settled);
    }
  }
  return result;
}
