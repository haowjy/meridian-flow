/**
 * Settling the inline merge: combining two sides' insertions at one point, and choosing the whitespace
 * before each merged word. Both work on `MergedTok`s and know nothing about hunks or blocks.
 */
import type { Mark } from "prosemirror-model";
import { equalOrderedMatches } from "../ordered-matching.js";
import { BASE, DRAFT, isSubsequence, LIVE, type MergedTok, type Origin } from "./merge-hunks.js";
import { coreKey, isBlockTok, isWordTok, type Tok } from "./tokens.js";

/** Word-by-word union of two token runs; a shared word is kept once, in the draft's form. */
function unionWords(live: MergedTok[], draft: MergedTok[]): MergedTok[] {
  const matches = equalOrderedMatches(
    live.map((o) => coreKey(o.tok)),
    draft.map((o) => coreKey(o.tok)),
  );
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

/** A run of tokens split into the part before the first paragraph start, and the paragraphs. */
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

/**
 * Both sides inserted at one point. Text before any new paragraph merges word by word (a shared
 * word is kept once, in the draft's form). New paragraphs merge whole: an identical paragraph is kept
 * once, different ones are both kept (live's first). A live paragraph that could be one of the
 * draft's, and is not equal to it, never gets here: `settleStretches` dropped it as a clash.
 */
export function unionInsertions(live: MergedTok[], draft: MergedTok[]): MergedTok[] {
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
    // Between two identical paragraphs both sides' others stay, live's first.
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

// Scripts written without spaces between words: gluing two of their segments is normal.
const SPACELESS =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
/** Two words that no side had side by side need a space between them, unless either is spaceless script. */
const needsSpace = (prev: Tok, next: Tok) =>
  isWordTok(prev) &&
  isWordTok(next) &&
  !(prev.kind === "text" && SPACELESS.test(prev.core.at(-1) ?? "")) &&
  !(next.kind === "text" && SPACELESS.test(next.core[0] ?? ""));

type TextTok = Extract<Tok, { kind: "text" }>;

const whitespaceKey = (t: TextTok | null) =>
  t === null
    ? null
    : `${t.ws}\u0001${t.wsMarks ? JSON.stringify(t.wsMarks.map((m) => m.toJSON())) : ""}`;

/**
 * Whitespace before each token, taken from a version where the same two tokens are neighbours. Each
 * document's token arrays and the base-to-live and base-to-draft token maps say where a merged token
 * sits in that document.
 */
export function settleWhitespace(
  merged: MergedTok[],
  docs: { base: Tok[]; live: Tok[]; draft: Tok[] },
  baseToLive: Int32Array,
  baseToDraft: Int32Array,
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
    // The token as each document has it, if it sits after the same neighbour there.
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
    // Whoever changed the whitespace wins; the draft if both did.
    let from: TextTok | null;
    if (liveKey !== null && draftKey !== null)
      from =
        baseKey !== null
          ? liveKey === baseKey
            ? draftTok
            : draftKey === baseKey
              ? liveTok
              : draftTok
          : draftTok;
    else if (liveKey !== null) from = liveTok;
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
