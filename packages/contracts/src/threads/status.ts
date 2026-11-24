import { z } from "zod";

export const turnStatusSchema = z.enum([
  "pending",
  "streaming",
  "awaiting_answer",
  "complete",
  "cancelled",
  "error",
]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

export function isTerminalTurnStatus(status: TurnStatus): boolean {
  return (
    status === "awaiting_answer" ||
    status === "complete" ||
    status === "cancelled" ||
    status === "error"
  );
}
