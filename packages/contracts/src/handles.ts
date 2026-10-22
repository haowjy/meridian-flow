/**
 * The one handle grammar: a lowercase letter and digits with no leading zero. A handle names an
 * owner or a thing the model reads (`c12` chat, `p3` subagent, `w3` Work) and is minted per project
 * from a counter, never reused. Names (a chat's title, a Work's name) are labels and never parse as
 * handles. Lowercase only: `W3` is refused, not folded, so a name copied into an address cannot
 * resolve as someone else's handle. Allocation stays with the server's repository adapters.
 */

/** The letter of each handle kind. Edit handles (`e`) and branch handles (`b`) are not owners. */
export const HANDLE_LETTERS = { chat: "c", subagent: "p", work: "w" } as const;
export type HandleKind = keyof typeof HANDLE_LETTERS;

/** A thread is a primary chat or a subagent; they share one counter. */
export type ThreadHandleKind = "primary" | "subagent";

const HANDLE_PATTERN = /^([a-z])([1-9][0-9]*)$/;
const ANY_CASE_HANDLE_PATTERN = /^([a-zA-Z])([1-9][0-9]*)$/;
const LEADING_ZERO_PATTERN = /^[a-zA-Z]0[0-9]*$/;

declare const workHandleBrand: unique symbol;

/** A Work's permanent handle, `w3`. The locked No Work row has none. */
export type WorkHandle = string & { readonly [workHandleBrand]: "WorkHandle" };

export interface ParsedHandle {
  kind: HandleKind;
  n: number;
  /** The canonical spelling. */
  handle: string;
}

export function formatHandle(kind: HandleKind, n: number): string {
  return `${HANDLE_LETTERS[kind]}${n}`;
}

/** Parse a canonical handle of a known kind; null for any other spelling. */
export function parseHandle(raw: string): ParsedHandle | null {
  const match = HANDLE_PATTERN.exec(raw);
  if (!match) return null;
  const kind = (Object.keys(HANDLE_LETTERS) as HandleKind[]).find(
    (candidate) => HANDLE_LETTERS[candidate] === match[1],
  );
  return kind ? { kind, n: Number(match[2]), handle: raw } : null;
}

export function formatWorkHandle(n: number): WorkHandle {
  return formatHandle("work", n) as WorkHandle;
}

/** Decode a persisted or wire Work handle; null for anything that is not `w<n>`. */
export function decodeWorkHandle(value: unknown): WorkHandle | null {
  return typeof value === "string" && parseHandle(value)?.kind === "work"
    ? (value as WorkHandle)
    : null;
}

export function formatThreadRef(kind: ThreadHandleKind, n: number): string {
  return formatHandle(kind === "subagent" ? "subagent" : "chat", n);
}

/** Parse `c12` or `p3`; Work handles are not thread refs. */
export function parseThreadRef(ref: string): { kind: ThreadHandleKind; n: number } | null {
  const parsed = parseHandle(ref);
  if (!parsed || parsed.kind === "work") return null;
  return { kind: parsed.kind === "subagent" ? "subagent" : "primary", n: parsed.n };
}

/** How the token after `@` reads, for the error that names the right handle. */
export type HandleToken =
  | { kind: "handle"; handle: ParsedHandle }
  /** Handle-shaped with a letter that names no owner kind, such as `x5`. */
  | { kind: "unknown-letter"; token: string }
  /** `W3`: the lowercase spelling is `lower`. */
  | { kind: "uppercase"; token: string; lower: string }
  /** `w03`: a letter and digits with a leading zero. */
  | { kind: "leading-zero"; token: string }
  /** Anything else: the writer's name for something, never an address. */
  | { kind: "name"; token: string };

export function classifyHandleToken(token: string): HandleToken {
  const handle = parseHandle(token);
  if (handle) return { kind: "handle", handle };
  if (HANDLE_PATTERN.test(token)) return { kind: "unknown-letter", token };
  if (ANY_CASE_HANDLE_PATTERN.test(token))
    return { kind: "uppercase", token, lower: token.toLowerCase() };
  if (LEADING_ZERO_PATTERN.test(token)) return { kind: "leading-zero", token };
  return { kind: "name", token };
}
