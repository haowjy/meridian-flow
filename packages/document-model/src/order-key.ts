const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export type Random = () => number;

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

export function compareOrder(keyA: string, idA: string, keyB: string, idB: string): number {
  return keyA < keyB ? -1 : keyA > keyB ? 1 : idA < idB ? -1 : idA > idB ? 1 : 0;
}

export function orderKeys(
  list: readonly string[],
  current: ReadonlyMap<string, string | undefined>,
  random: Random,
  pinned: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const n = list.length;
  const keyOf = (i: number) => current.get(list[i]);
  const keep = new Set<number>();
  let segment: number[] = [];
  let low: string | null = null;
  const close = (high: string | null) => {
    const fits = segment.filter((i) => {
      const key = keyOf(i) as string;
      return (low === null || key > low) && (high === null || key < high);
    });
    for (const i of longestRun(fits, keyOf)) keep.add(i);
    segment = [];
  };
  for (let i = 0; i < n; i++) {
    const key = keyOf(i);
    if (typeof key !== "string") continue;
    if (!pinned.has(list[i])) {
      segment.push(i);
      continue;
    }
    close(key);
    keep.add(i);
    low = key;
  }
  close(null);
  const upper = new Array<string | null>(n);
  for (let i = n - 1, next: string | null = null; i >= 0; i--) {
    upper[i] = next;
    if (keep.has(i)) next = keyOf(i) as string;
  }
  const result = new Map<string, string>();
  let lower: string | null = null;
  for (let i = 0; i < n; i++) {
    lower = keep.has(i) ? (keyOf(i) as string) : keyBetween(lower, upper[i], random);
    result.set(list[i], lower);
  }
  return result;
}

function longestRun(
  indices: readonly number[],
  keyOf: (i: number) => string | undefined,
): number[] {
  const previous = new Map<number, number>();
  const tails: number[] = [];
  for (const i of indices) {
    const key = keyOf(i) as string;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((keyOf(tails[mid]) as string) < key) lo = mid + 1;
      else hi = mid;
    }
    previous.set(i, lo > 0 ? tails[lo - 1] : -1);
    tails[lo] = i;
  }
  const run: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous.get(i) ?? -1) run.push(i);
  return run;
}
