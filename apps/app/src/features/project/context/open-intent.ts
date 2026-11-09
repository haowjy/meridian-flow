/**
 * Latest-wins claims for opens that finish after an await (a door's lookup, a launch):
 * a slower, older attempt must not replace a newer choice.
 */
let latest = 0;

export function claimOpenIntent(): number {
  latest += 1;
  return latest;
}

export function isCurrentOpenIntent(claim: number): boolean {
  return latest === claim;
}
