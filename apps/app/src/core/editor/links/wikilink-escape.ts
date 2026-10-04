/**
 * Keeps an escaped `\[[` (or `\[\[`) as the characters it spells when the
 * clipboard door reads Markdown. `WikilinkPasteExtension` contributes it, so
 * it is only ever mounted beside the transform that spells the escape out.
 *
 * Markdown's own escape turns `\[` into `[`, so by the time a paste reaches
 * the wikilink transform an escaped `\[[Name]]` would look exactly like a
 * link the writer meant. This micromark text construct claims the escape
 * first (ahead of the core character escape) and hands the raw characters to
 * the text node, so the transform can see the escape, leave the brackets as
 * text, and drop the backslash. Code is never tokenized as text, so a code
 * span keeps its backslash.
 */

import type { Plugin } from "unified";

const BACKSLASH = 92;
const LEFT_BRACKET = 91;
const TOKEN = "wikilinkEscape";

// The few micromark and mdast-util-from-markdown shapes this construct
// touches, stated locally rather than depending on their type packages.
type Code = number | null;
type State = (code: Code) => State | undefined;
type Effects = {
  enter: (type: string) => unknown;
  consume: (code: Code) => void;
  exit: (type: string) => unknown;
};
type Handle = (
  this: { config: { enter: Record<string, Handle>; exit: Record<string, Handle> } },
  token: unknown,
) => void;

function tokenize(effects: Effects, ok: State, nok: State): State {
  const bracket =
    (next: State): State =>
    (code) => {
      if (code !== LEFT_BRACKET) return nok(code);
      effects.consume(code);
      return next;
    };
  const close: State = (code) => {
    effects.exit(TOKEN);
    return ok(code);
  };
  // `\[` then `[`, or `\[` then `\[`: Meridian's own Markdown writes `\[\[`.
  const second: State = (code) => {
    if (code === BACKSLASH) {
      effects.consume(code);
      return bracket(close);
    }
    return bracket(close)(code);
  };
  return (code) => {
    effects.enter(TOKEN);
    effects.consume(code);
    return bracket(second);
  };
}

const enterData: Handle = function (token) {
  this.config.enter.data?.call(this, token);
};
const exitData: Handle = function (token) {
  this.config.exit.data?.call(this, token);
};

/** The remark plugin the clipboard door's codec adds. */
export const remarkKeepWikilinkEscapes: Plugin = function () {
  const data = this.data() as Record<string, unknown[] | undefined>;
  data.micromarkExtensions = [
    ...(data.micromarkExtensions ?? []),
    { text: { [BACKSLASH]: { name: TOKEN, tokenize } } },
  ];
  data.fromMarkdownExtensions = [
    ...(data.fromMarkdownExtensions ?? []),
    { enter: { [TOKEN]: enterData }, exit: { [TOKEN]: exitData } },
  ];
};
