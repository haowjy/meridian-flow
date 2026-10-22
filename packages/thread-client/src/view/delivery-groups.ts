/** delivery-groups: which consecutive completion events one reply shows as a single merged row. */
import type { DeliveryEvent } from "./transcript-model";

/** Merge only contiguous completion notices; any other delivery breaks a group. */
export function groupDeliveryEvents(
  events: readonly DeliveryEvent[],
): readonly (readonly DeliveryEvent[])[] {
  const groups: DeliveryEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (event.subagentUpdate && current?.[0]?.subagentUpdate) current.push(event);
    else groups.push([event]);
  }
  return groups;
}
