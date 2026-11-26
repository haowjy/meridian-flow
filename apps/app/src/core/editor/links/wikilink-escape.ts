import type { Plugin } from "unified";

const BACKSLASH = 92;
const LEFT_BRACKET = 91;
const TOKEN = "wikilinkEscape";

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
