import type { Mark, ResolvedPos } from "@tiptap/pm/model";

export type AutoPairContext = "prose" | "code-fence" | "inline-code";

export type AutoPairSpec = {
  open: string;
  close: string;
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

const CLOSER_WELCOME = /[\s)\]}>"'`,.;:!?]/;

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

export function resolveAutoPairContext(
  $from: ResolvedPos,
  storedMarks: readonly Mark[] | null,
): AutoPairContext | null {
  if (!$from.parent.isTextblock) return null;
  if ($from.parent.type.spec.code) return "code-fence";
  const marks = storedMarks ?? $from.marks();
  return marks.some((mark) => mark.type.spec.code === true) ? "inline-code" : "prose";
}

export function autoPairForOpener(
  character: string,
  context: AutoPairContext,
): AutoPairSpec | null {
  for (const spec of EDITOR_AUTO_PAIRS) {
    if (spec.open === character && spec.contexts.includes(context)) return spec;
  }
  return null;
}

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
