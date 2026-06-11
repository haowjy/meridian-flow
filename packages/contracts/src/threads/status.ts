import type { TurnStatus } from "../enums.js";

export type { TurnStatus } from "../enums.js";

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return status === "complete" || status === "cancelled" || status === "error";
}
