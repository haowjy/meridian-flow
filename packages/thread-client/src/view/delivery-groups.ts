/** delivery-groups: which consecutive completion events one reply shows as a single merged row. */
import type { DeliveryEvent } from "./transcript-model";

export type DeliveryGroup = { id: string; events: readonly DeliveryEvent[] };
const cache = new WeakMap<object, DeliveryGroup>();

function sameGroup(left: DeliveryGroup, right: DeliveryGroup): boolean {
  const fields = {
    id: "value",
    events: "references",
  } satisfies Record<keyof DeliveryGroup, "value" | "references">;
  return (Object.keys(fields) as (keyof DeliveryGroup)[]).every((field) => {
    if (fields[field] === "value") return left[field] === right[field];
    const leftEvents = left.events;
    const rightEvents = right.events;
    return (
      leftEvents.length === rightEvents.length &&
      leftEvents.every((event, index) => event === rightEvents[index])
    );
  });
}

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
    const group = { id, events };
    if (previous && sameGroup(previous, group)) return previous;
    cache.set(first.turn, group);
    return group;
  });
}
