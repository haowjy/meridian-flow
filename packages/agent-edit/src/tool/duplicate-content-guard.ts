// Detects model recovery flailing that reintroduces existing top-level content as new draft rows.
import type { BlockSnapshot } from "../apply/echo.js";

export interface DuplicateContentGuardInput {
  protectedSnapshots: readonly (readonly BlockSnapshot[])[];
  before: readonly BlockSnapshot[];
  after: readonly BlockSnapshot[];
}

export interface DuplicateContentGuardResult {
  ok: boolean;
  reason?: "duplicate_top_level_sequence";
}

export const DUPLICATE_CONTENT_RETRY_GUIDANCE =
  'There is no move/reorder command. To move content: first `replace(find=<source text>, content="")` (or otherwise remove the source), then `insert(after=<target anchor>, content=<moved text>)`. Do NOT recreate the whole document as new content; edit in place.';

const MIN_DUPLICATE_SEQUENCE_LENGTH = 2;

export function detectDuplicateTopLevelContent(
  input: DuplicateContentGuardInput,
): DuplicateContentGuardResult {
  const beforeHashes = new Set(input.before.map((block) => block.hash));
  const introduced = input.after.filter((block) => !beforeHashes.has(block.hash));
  if (introduced.length === 0) return { ok: true };

  const protectedSequences = input.protectedSnapshots
    .map((snapshot) => normalizedBodies(snapshot))
    .filter((sequence) => sequence.length >= MIN_DUPLICATE_SEQUENCE_LENGTH);
  if (protectedSequences.length === 0) return { ok: true };

  const introducedSequences = candidateIntroducedSequences(introduced);
  for (const introducedSequence of introducedSequences) {
    if (introducedSequence.length < MIN_DUPLICATE_SEQUENCE_LENGTH) continue;
    for (const protectedSequence of protectedSequences) {
      if (duplicatesProtectedSequence(introducedSequence, protectedSequence)) {
        return { ok: false, reason: "duplicate_top_level_sequence" };
      }
    }
  }

  return { ok: true };
}

function duplicatesProtectedSequence(
  introduced: readonly string[],
  protectedSequence: readonly string[],
): boolean {
  if (
    introduced.length === protectedSequence.length &&
    sameSequence(introduced, protectedSequence)
  ) {
    return true;
  }
  return containsContiguousSubsequence(
    introduced,
    protectedSequence,
    MIN_DUPLICATE_SEQUENCE_LENGTH,
  );
}

function candidateIntroducedSequences(blocks: readonly BlockSnapshot[]): string[][] {
  const blockSequence = normalizedBodies(blocks);
  const splitSequences = blocks.flatMap((block) => {
    const lines = bodyWithoutHash(block.serialized)
      .split(/\r?\n+/)
      .map(normalizeText)
      .filter(Boolean);
    return lines.length >= MIN_DUPLICATE_SEQUENCE_LENGTH ? [lines] : [];
  });
  return [blockSequence, ...splitSequences].filter(
    (sequence) => sequence.length >= MIN_DUPLICATE_SEQUENCE_LENGTH,
  );
}

function normalizedBodies(blocks: readonly BlockSnapshot[]): string[] {
  return blocks.map((block) => normalizeText(bodyWithoutHash(block.serialized))).filter(Boolean);
}

function bodyWithoutHash(serialized: string): string {
  const separator = serialized.indexOf("|");
  return (separator < 0 ? serialized : serialized.slice(separator + 1)).replace(/^\n/, "");
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function sameSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function containsContiguousSubsequence(
  haystack: readonly string[],
  needle: readonly string[],
  minLength: number,
): boolean {
  const maxLength = Math.min(haystack.length, needle.length);
  for (let length = maxLength; length >= minLength; length -= 1) {
    for (let needleStart = 0; needleStart <= needle.length - length; needleStart += 1) {
      const slice = needle.slice(needleStart, needleStart + length);
      if (containsSequence(haystack, slice)) return true;
    }
  }
  return false;
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
