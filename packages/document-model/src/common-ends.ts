/**
 * How many items `a` and `b` share at the start, then how many of what is left they share at the
 * end: the one place two sequences differ is `a[start, a.length - end)` against
 * `b[start, b.length - end)`.
 */
export function commonEnds<T>(a: ArrayLike<T>, b: ArrayLike<T>): { start: number; end: number } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return { start, end };
}
