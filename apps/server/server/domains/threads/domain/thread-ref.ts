/**
 * Canonical model-facing thread handle grammar: `cN` for primaries, `pN` for
 * subagents (spawn). Allocation stays with the repository adapters; this module
 * only formats and parses handles.
 */
import type { Thread } from "@meridian/contracts/threads";

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
