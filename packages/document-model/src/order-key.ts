/**
 * Fractional order keys (design §1, "Order is content"). A key is base-62, compared as a string,
 * with ties broken by block id. A generated key ends in two random characters and `V`, so two
 * peers inserting at one position never tie, and no key ends in `0`, which is what leaves room
 * below every key. Nothing rebalances: a key is written only for a block whose relative order
 * changed.
 */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type Random = () => number;

/** A key strictly between `lower` and `upper` (either null for open). */
export function keyBetween(lower: string | null, upper: string | null, random: Random): string {
  let prefix = "";
  let high = upper;
  for (let i = 0; ; i++) {
    const lo = lower !== null && i < lower.length ? ALPHABET.indexOf(lower[i]) : 0;
    const hi = high !== null && i < high.length ? ALPHABET.indexOf(high[i]) : 61;
    if (lo < 0 || hi < 0 || lo > hi) throw new Error(`invalid order key bounds ${lower} ${upper}`);
    if (hi - lo > 1) {
      const pick = () => ALPHABET[Math.floor(random() * 62)];
      return `${prefix}${ALPHABET[Math.floor((lo + hi) / 2)]}${pick()}${pick()}V`;
    }
    prefix += ALPHABET[lo];
    if (lo < hi) high = null;
  }
}

/** Sibling order: by key, then by id. */
export function compareOrder(keyA: string, idA: string, keyB: string, idB: string): number {
  return keyA < keyB ? -1 : keyA > keyB ? 1 : idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * Keys for `list`, in order, given each id's current key among these siblings (absent for a block
 * new to this parent). The longest run already in order keeps its keys; only the rest get new ones.
 */
export function orderKeys(
  list: readonly string[],
  current: ReadonlyMap<string, string | undefined>,
  random: Random,
): Map<string, string> {
  // The longest run of current keys in strictly increasing order, by patience sorting: `tails[k]`
  // is the index ending the best run of length k + 1 found so far.
  const n = list.length;
  const previous = new Array<number>(n).fill(-1);
  const tails: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = current.get(list[i]);
    if (typeof key !== "string") continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((current.get(list[tails[mid]]) as string) < key) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) keep.add(i);
  const upper = new Array<string | null>(n);
  for (let i = n - 1, next: string | null = null; i >= 0; i--) {
    upper[i] = next;
    if (keep.has(i)) next = current.get(list[i]) as string;
  }
  const result = new Map<string, string>();
  let lower: string | null = null;
  for (let i = 0; i < n; i++) {
    lower = keep.has(i) ? (current.get(list[i]) as string) : keyBetween(lower, upper[i], random);
    result.set(list[i], lower);
  }
  return result;
}
