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

export const EDITOR_AUTO_PAIRS: readonly AutoPairSpec[] = [
  { open: "[", close: "]", contexts: EVERYWHERE },
  { open: "(", close: ")", contexts: EVERYWHERE },
  { open: '"', close: '"', contexts: EVERYWHERE },
  { open: "{", close: "}", contexts: SOURCE_ONLY },
  { open: "'", close: "'", contexts: SOURCE_ONLY },
  { open: "`", close: "`", contexts: FENCE_ONLY },
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

  if (spec.open === spec.close && before !== null) {
    if (WORD_CHARACTER.test(before) || before === spec.open) return false;
  }

  return true;
}
