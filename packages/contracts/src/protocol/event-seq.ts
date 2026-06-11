const EVENT_SEQ_PATTERN = /^(0|[1-9]\d*)$/;

export function parseSeq(seq: string): string | null {
  return EVENT_SEQ_PATTERN.test(seq) ? seq : null;
}

export function compareSeq(a: string, b: string): number {
  const aVal = parseSeq(a);
  const bVal = parseSeq(b);
  if (aVal !== null && bVal !== null) {
    if (aVal === bVal) return 0;
    if (aVal.length !== bVal.length) return aVal.length > bVal.length ? 1 : -1;
    return aVal > bVal ? 1 : -1;
  }

  if (a === b) return 0;
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a > b ? 1 : -1;
}
