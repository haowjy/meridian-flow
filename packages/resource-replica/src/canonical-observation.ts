/** One freshness rule for server canonical observations, independent of local CAS revisions. */
export function newerCanonicalObservation(incoming: string, held?: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(incoming))
    throw new TypeError("Invalid canonical observation version");
  return held === undefined || BigInt(incoming) > BigInt(held);
}

/** A receipt fences refresh completion, not the freshness of intermediate canonical evidence. */
export function canonicalRefreshObservation(
  incoming: string,
  held?: string,
  receiptVersion?: string,
) {
  const newer = newerCanonicalObservation(incoming, held);
  const completes =
    (newer || incoming === held) &&
    (receiptVersion === undefined || BigInt(incoming) >= BigInt(receiptVersion));
  return { newer, completes };
}
