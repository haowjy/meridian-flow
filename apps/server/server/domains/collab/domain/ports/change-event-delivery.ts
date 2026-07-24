/** Best-effort delivery boundary for committed change events in live document rooms. */

import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";

export type ChangeEventDelivery = {
  /** Delivery is deliberately fire-and-forget and must not fail branch push. */
  deliver(message: Omit<ChangeEventWsMessage, "type">): void;
};
