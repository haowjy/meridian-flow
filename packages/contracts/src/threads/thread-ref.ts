/**
 * Canonical thread handle grammar: `cN` for primaries, `pN` for subagents, from one
 * per-project counter. The model addresses threads by ref, and the HTTP API resolves
 * one within a project. Allocation stays with the server's repository adapters.
 */
import type { Thread } from "./index.js";

const THREAD_REF_PATTERN = /^([pc])([1-9]\d*)$/;

export function formatThreadRef(kind: Thread["kind"], n: number): string {
  return `${kind === "subagent" ? "p" : "c"}${n}`;
}

export function parseThreadRef(ref: string): { kind: Thread["kind"]; n: number } | null {
  const match = THREAD_REF_PATTERN.exec(ref);
  if (!match) return null;
  const [, prefix, digits] = match;
  if (!prefix || !digits) return null;
  return { kind: prefix === "p" ? "subagent" : "primary", n: Number(digits) };
}
