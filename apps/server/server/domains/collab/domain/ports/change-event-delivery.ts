/** Best-effort delivery boundary for committed change events in live document rooms. */

import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { SweptChangesByRecipient } from "../sweep-policy.js";

export type ChangeEventDelivery = {
  /** Delivery is deliberately fire-and-forget and must not fail branch push. */
  deliver(message: Omit<ChangeEventWsMessage, "type">, sweptChanges: SweptChangesByRecipient): void;
};
