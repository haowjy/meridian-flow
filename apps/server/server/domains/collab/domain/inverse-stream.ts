import type { StoredInversePart } from "./turn-inverse-service.js";

export type InverseStep = {
  actionId: string;
  actionKind: "undo" | "revert";
  at: number;
  parts: StoredInversePart[];
};
