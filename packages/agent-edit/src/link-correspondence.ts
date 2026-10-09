// Pure link identity correspondence over host-provided address and observation evidence.
import { type Candidate, matchOccurrences } from "./link-correspondence-matching.js";

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
  /** The holder's current URI, for compatibility with current spellings. */
  holderUri: string;
  /** Written href → canonical absolute address in the same key space, or null if not internal. */
  normalize(href: string, holderUri: string): string | null;
  /** Current liveness of a ref, for pass 2 ties. */
  isLive(ref: string): boolean;
}
export type Binding = { pass: 1; occurrence: number } | { pass: 2; ref: string } | { pass: 3 };
export interface CorrespondenceResult {
  bindings: Binding[];
  /** Whether document-order completion was proven optimal (the first five ranks always are). */
  exact: boolean;
  /** Deterministic candidate visits in global document-order completion. */
  orderSearchSteps: number;
}

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

/**
 * Passes 1 and 2 of ref assignment; pass 3 remains the caller's responsibility.
 *
 * The five additive ranks are exact lexicographic assignments, never scalar
 * weights. Order is completed globally, including across compatibility components.
 * After 50,000 candidate visits, completion deterministically returns the best
 * visited matching (including the initial assignment), with all five additive
 * ranks still optimal. Only order agreements and the final document-order tie
 * may differ from exhaustive search. Use correspondLinksWithDiagnostics when
 * the caller needs to record this exceptional fallback.
 */
export function correspondLinks(input: CorrespondenceInput): Binding[] {
  return correspondLinksWithDiagnostics(input).bindings;
}

/** The same binding operation with observable bounded-search status. */
export function correspondLinksWithDiagnostics(input: CorrespondenceInput): CorrespondenceResult {
  const history = new Map<string, ShownLink[]>();
  for (const showing of input.shown) {
    const entries = history.get(showing.ref) ?? [];
    entries.push(showing);
    history.set(showing.ref, entries);
  }
  for (const entries of history.values()) entries.sort(showingOrder);
  const normalized = new Map<string, Array<string | null>>();
  const addresses = (holderUri: string) => {
    let result = normalized.get(holderUri);
    if (!result) {
      result = input.written.map(({ href }) => input.normalize(href, holderUri));
      normalized.set(holderUri, result);
    }
    return result;
  };
  const current = addresses(input.holderUri);
  const candidates: Candidate[][] = input.written.map(() => []);
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
      if (compatible)
        candidates[j].push({
          occurrence,
          score: [
            Number(strong),
            1,
            Number(written.label === old.label),
            continuity(old.label, written.label),
            Number(old.live),
          ],
        });
    });
  });
  const matching = matchOccurrences(candidates, input.old.length);
  const latest = [...history.values()].map((entries) => entries[0]);
  const live = new Map(latest.map((showing) => [showing.ref, input.isLive(showing.ref)]));
  latest.sort((a, b) => Number(live.get(b.ref)) - Number(live.get(a.ref)) || showingOrder(a, b));
  const bindings = input.written.map((_, j): Binding => {
    const occurrence = matching.occurrences[j];
    if (occurrence >= 0) return { pass: 1, occurrence };
    const showing = latest.find((candidate) => {
      const address = addresses(candidate.holderUri)[j];
      return address !== null && address === candidate.address;
    });
    return showing ? { pass: 2, ref: showing.ref } : { pass: 3 };
  });
  return { bindings, exact: matching.exact, orderSearchSteps: matching.steps };
}
