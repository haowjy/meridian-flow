/** delivery-groups: which consecutive completion events one reply shows as a single merged row. */
import type { DeliveryEvent } from "./transcript-model";

export type DeliveryGroup = { id: string; events: readonly DeliveryEvent[] };
const cache = new WeakMap<object, DeliveryGroup>();

/** Merge only contiguous completion notices; any other delivery breaks a group. */
export function groupDeliveryEvents(events: readonly DeliveryEvent[]): readonly DeliveryGroup[] {
  const groups: DeliveryEvent[][] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (event.subagentUpdate && current?.[0]?.subagentUpdate) current.push(event);
    else groups.push([event]);
  }
  return groups.map((events) => {
    const first = events[0];
    if (!first) throw new Error("Delivery groups are never empty");
    const id = first.turn.id;
    const previous = cache.get(first.turn);
    if (
      previous?.id === id &&
      previous.events.length === events.length &&
      previous.events.every((event, index) => event === events[index])
    )
      return previous;
    const group = { id, events };
    cache.set(first.turn, group);
    return group;
  });
}
