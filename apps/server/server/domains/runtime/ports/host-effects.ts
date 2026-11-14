/** What a runtime commit owes the host, delivered after the commit; see the `host_effects` table. */
import type { JsonValue } from "@meridian/contracts/threads";

export interface HostEffect {
  id: string;
  threadId: string;
  kind: string;
  payload: JsonValue;
}

/**
 * Delivery is at least once and in no order, so a handler gives the same result when repeated,
 * does all its work in one transaction of the host's, and reads nothing about the thread: the
 * payload carries what it needs. A handler that throws is called again on a later tick.
 */
export interface HostEffects {
  handle(effect: HostEffect): Promise<void>;
}
