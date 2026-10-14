/**
 * Purpose: Normalizes and compares event sequence strings for resumable thread streams.
 * Why independent: Sequence values are wire-protocol cursors shared by HTTP and WebSocket consumers, not server event-log logic.
 */
const EVENT_SEQ_PATTERN = /^(0|[1-9]\d*)$/;

/** Validate and normalize an event sequence string. */
export function parseSeq(seq: string): string | null {
  return EVENT_SEQ_PATTERN.test(seq) ? seq : null;
}

/** Compare two event sequence values (decimal strings). */
export function compareSeq(a: string, b: string): number {
  const aVal = parseSeq(a);
  const bVal = parseSeq(b);
  if (aVal !== null && bVal !== null) {
    if (aVal === bVal) return 0;
    if (aVal.length !== bVal.length) return aVal.length > bVal.length ? 1 : -1;
    return aVal > bVal ? 1 : -1;
  }

  if (a === b) {
    return 0;
  }
  if (a.length !== b.length) {
    return a.length > b.length ? 1 : -1;
  }
  return a > b ? 1 : -1;
}

/** The last seq a snapshot covers: its `nextSeq` minus one, or "0" for a thread with no events. */
export function headSeq(nextSeq: string): string {
  const next = parseSeq(nextSeq);
  if (next === null || next === "0") return "0";
  return (BigInt(next) - 1n).toString();
}
