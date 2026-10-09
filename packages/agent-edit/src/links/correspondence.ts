// Pure link identity correspondence over host-provided address and observation evidence.
import { type CandidateRow, matchOccurrences } from "./correspondence-matching.js";

/** One showing of a link to the model in this holder document (host-only evidence). */
export interface ShownLink {
  ref: string;
  /** Canonical absolute address shown, without suffix (the speller's key space). */
  address: string;
  /** The holder's URI when it was shown; written relative hrefs normalize against it. */
  holderUri: string;
  /** Observation order; larger is more recent. */
  at: number;
}
export interface OldOccurrence {
  /** Plain text of the linked run, in the replaced span, in document order. */
  label: string;
  ref: string;
  /** Canonical absolute address it spells now (no suffix). */
  current: string;
  /** Its target resolves live now (resolution rules 1 and 3). */
  live: boolean;
}
export interface WrittenLink {
  label: string;
  /** Destination as written, suffix stripped (relative or full). */
  href: string;
}
export interface CorrespondenceInput {
  old: readonly OldOccurrence[];
  written: readonly WrittenLink[];
  shown: readonly ShownLink[];
  /** The holder's current URI (null: none), for compatibility with current spellings. */
  holderUri: string | null;
  /** Written href → canonical absolute address in the same key space, or null if not internal. */
  normalize(href: string, holderUri: string | null): string | null;
  /** Current liveness of a shown ref at the address it was shown, for pass 2 ties. */
  isLive(ref: string, address: string): boolean;
}
export type LinkMatch = { pass: 1; occurrence: number } | { pass: 2; ref: string } | { pass: 3 };
function continuity(a: string, b: string) {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  // Prefix and suffix may not count the same character twice.
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  return prefix + suffix;
}

function showingOrder(a: ShownLink, b: ShownLink) {
  // Equal observation times have no normative identity ordering. Use opaque data
  // ordering rather than array iteration order to keep the module deterministic.
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return a.holderUri < b.holderUri ? -1 : a.holderUri > b.holderUri ? 1 : 0;
}

/** Passes 1 and 2 of ref assignment; classification and fresh resolution remain the caller's. */
export function correspondLinks(input: CorrespondenceInput): LinkMatch[] {
  const history = new Map<string, ShownLink[]>();
  for (const showing of input.shown) {
    const entries = history.get(showing.ref) ?? [];
    entries.push(showing);
    history.set(showing.ref, entries);
  }
  for (const entries of history.values()) entries.sort(showingOrder);
  const normalized = new Map<string | null, Array<string | null>>();
  const addresses = (holderUri: string | null) => {
    let result = normalized.get(holderUri);
    if (!result) {
      result = input.written.map(({ href }) => input.normalize(href, holderUri));
      normalized.set(holderUri, result);
    }
    return result;
  };
  const current = addresses(input.holderUri);
  const candidates: CandidateRow[] = input.written.map(() => ({ occurrences: [], scores: [] }));
  input.old.forEach((old, occurrence) => {
    const showings = history.get(old.ref) ?? [];
    const latest = showings[0];
    const view = latest ? addresses(latest.holderUri) : current;
    input.written.forEach((written, j) => {
      const strong = latest
        ? view[j] !== null && view[j] === latest.address
        : current[j] !== null && current[j] === old.current;
      const compatible =
        strong ||
        (current[j] !== null && current[j] === old.current) ||
        showings.some((showing) => {
          const address = addresses(showing.holderUri)[j];
          return address !== null && address === showing.address;
        });
      if (compatible) {
        candidates[j].occurrences.push(occurrence);
        candidates[j].scores.push(
          Number(strong),
          1,
          Number(written.label === old.label),
          continuity(old.label, written.label),
          Number(old.live),
          -Math.abs(j * (input.old.length - 1) - occurrence * (input.written.length - 1)),
        );
      }
    });
  });
  const matching = matchOccurrences(candidates, input.old.length);
  const latest = [...history.values()].map((entries) => entries[0]);
  const live = new Map(
    latest.map((showing) => [showing.ref, input.isLive(showing.ref, showing.address)]),
  );
  latest.sort((a, b) => Number(live.get(b.ref)) - Number(live.get(a.ref)) || showingOrder(a, b));
  const matches = input.written.map((_, j): LinkMatch => {
    const occurrence = matching[j];
    if (occurrence >= 0) return { pass: 1, occurrence };
    const showing = latest.find((candidate) => {
      const address = addresses(candidate.holderUri)[j];
      return address !== null && address === candidate.address;
    });
    return showing ? { pass: 2, ref: showing.ref } : { pass: 3 };
  });
  return matches;
}
