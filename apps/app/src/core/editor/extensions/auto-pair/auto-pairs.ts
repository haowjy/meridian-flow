/**
 * Which characters close themselves as the writer types them, and where.
 *
 * A writer who types `[` almost always means `[…]`, so the editor writes the
 * closer and leaves the caret between the two. Everything that follows from
 * that — inserting the closer, stepping over it when the writer types it
 * anyway, taking both back on Backspace — is one mechanism reading this table
 * ([`AutoPairExtension.ts`](AutoPairExtension.ts)). Adding a pair is one row.
 *
 * **Pairs compose rather than spelling out combinations.** `[[` is not a row:
 * it is the `[` row firing twice, which is what makes `[[` give `[[]]` and
 * `]]` walk back out of both. Every row today is one character on each side
 * for that reason, and the mechanism reads the declared text rather than
 * assuming its length.
 */

import type { Mark, ResolvedPos } from "@tiptap/pm/model";

/**
 * Where a pair is live. Three, because the writer's expectation genuinely
 * differs: a backtick is a delimiter in prose, a quote character in a fence,
 * and the end of the span in inline code.
 */
export type AutoPairContext = "prose" | "code-fence" | "inline-code";

export type AutoPairSpec = {
  /** The text the writer types to open the pair; one character today. */
  open: string;
  /** The text written after the caret, and stepped over later. */
  close: string;
  /** Contexts the pair is live in. A context left out is a decision. */
  contexts: readonly AutoPairContext[];
};

const EVERYWHERE: readonly AutoPairContext[] = ["prose", "code-fence", "inline-code"];
const SOURCE_ONLY: readonly AutoPairContext[] = ["code-fence", "inline-code"];
const FENCE_ONLY: readonly AutoPairContext[] = ["code-fence"];

/**
 * The pairs, and the decisions that shaped the list.
 *
 * **`*`, `_` and `~` are deliberately absent.** Their completion path is the
 * markdown autoformat: a writer types `**bold**` and the input rule converts
 * the whole run to a mark. Auto-closing them would put the closing run in the
 * document before the rule could see it typed, so the rule would never fire
 * and the writer would be left holding literal asterisks. Same reasoning, same
 * decision: see `MarkdownAutoformatExtension`.
 *
 * **The backtick pairs in a fence and nowhere else.** In prose `` `code` `` is
 * the code mark's input rule, for the reason above. Inside an inline code span
 * a backtick is how the writer ends the span, so completing it would be a
 * closer they have to delete every time.
 *
 * **`'` is absent from prose** because an apostrophe is a letter there:
 * "don't" is not an unclosed quote.
 */
export const EDITOR_AUTO_PAIRS: readonly AutoPairSpec[] = [
  { open: "[", close: "]", contexts: EVERYWHERE },
  { open: "(", close: ")", contexts: EVERYWHERE },
  { open: '"', close: '"', contexts: EVERYWHERE },
  { open: "{", close: "}", contexts: SOURCE_ONLY },
  { open: "'", close: "'", contexts: SOURCE_ONLY },
  { open: "`", close: "`", contexts: FENCE_ONLY },
  // ── a new pair is one row here and nothing else ──────────────────
];

/**
 * What may sit immediately after the caret for a closer to be worth writing.
 *
 * Auto-closing in front of a word is how these features earn their bad
 * reputation: a writer putting brackets around a sentence they already wrote
 * types `[` in front of it and does not want `[]The`. Whitespace, the end of
 * the block, another closer, and trailing punctuation are the places where
 * nothing is being wrapped.
 */
const CLOSER_WELCOME = /[\s)\]}>"'`,.;:!?]/;

/** Letters and digits, in any script — a writer mid-word, not mid-gesture. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * The context the caret sits in, or null where no pair can be live (a gap
 * cursor, a node selection, anything that is not a text block).
 *
 * The schema's own `code` flag answers both source cases, the way
 * `isSourceBlock` does for blocks: nothing else reliably separates a fence
 * from a paragraph or an inline code span from prose.
 */
export function resolveAutoPairContext(
  $from: ResolvedPos,
  storedMarks: readonly Mark[] | null,
): AutoPairContext | null {
  if (!$from.parent.isTextblock) return null;
  if ($from.parent.type.spec.code) return "code-fence";
  const marks = storedMarks ?? $from.marks();
  return marks.some((mark) => mark.type.spec.code === true) ? "inline-code" : "prose";
}

/** The pair this character opens here, or null where it opens nothing. */
export function autoPairForOpener(
  character: string,
  context: AutoPairContext,
): AutoPairSpec | null {
  for (const spec of EDITOR_AUTO_PAIRS) {
    if (spec.open === character && spec.contexts.includes(context)) return spec;
  }
  return null;
}

/**
 * Whether the pair is worth completing at a caret with `before` behind it and
 * `after` in front of it. `null` means the caret is at the edge of the text
 * block; `""` means something that is not text sits there (an inline image),
 * which is a thing being wrapped rather than empty room.
 */
export function shouldAutoClose(
  spec: AutoPairSpec,
  before: string | null,
  after: string | null,
): boolean {
  if (after !== null && !CLOSER_WELCOME.test(after)) return false;

  // A pair whose halves are the same character cannot tell opening from
  // closing by the character alone, so what sits behind the caret decides.
  // A word means the character belongs to it: `6"` is inches and `don't` is a
  // word. The same character means a RUN the writer is building: ``` opens a
  // fence and """ opens a docstring, and neither is a stack of empty pairs.
  if (spec.open === spec.close && before !== null) {
    if (WORD_CHARACTER.test(before) || before === spec.open) return false;
  }

  return true;
}
