// keep: Handles are lowercase-only; folding case would let a name resolve as another owner's handle

export const HANDLE_LETTERS = { chat: "c", subagent: "p", work: "w" } as const;
export type HandleKind = keyof typeof HANDLE_LETTERS;

export type ThreadHandleKind = "primary" | "subagent";

const HANDLE_PATTERN = /^([a-z])([1-9][0-9]*)$/;
const ANY_CASE_HANDLE_PATTERN = /^([a-zA-Z])([1-9][0-9]*)$/;
const LEADING_ZERO_PATTERN = /^[a-zA-Z]0[0-9]*$/;

declare const workHandleBrand: unique symbol;

export type WorkHandle = string & { readonly [workHandleBrand]: "WorkHandle" };

export interface ParsedHandle {
  kind: HandleKind;
  n: number;
  handle: string;
}

export function formatHandle(kind: HandleKind, n: number): string {
  return `${HANDLE_LETTERS[kind]}${n}`;
}

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

export function decodeWorkHandle(value: unknown): WorkHandle | null {
  return typeof value === "string" && parseHandle(value)?.kind === "work"
    ? (value as WorkHandle)
    : null;
}

export function formatThreadRef(kind: ThreadHandleKind, n: number): string {
  return formatHandle(kind === "subagent" ? "subagent" : "chat", n);
}

export function parseThreadRef(ref: string): { kind: ThreadHandleKind; n: number } | null {
  const parsed = parseHandle(ref);
  if (!parsed || parsed.kind === "work") return null;
  return { kind: parsed.kind === "subagent" ? "subagent" : "primary", n: parsed.n };
}

export type HandleToken =
  | { kind: "handle"; handle: ParsedHandle }
  | { kind: "unknown-letter"; token: string }
  | { kind: "uppercase"; token: string; lower: string }
  | { kind: "leading-zero"; token: string }
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
