/** JSON-natural Work mutation receipts shared by runtime, reversal, and UI. */
import type { WorkId } from "../ids.js";
import type { WorkStatus } from "./index.js";

export type WorkReceiptState = {
  name: string;
  goal: string | null;
  description: string | null;
  status: WorkStatus;
};

export type WorkReceiptInverse =
  | { command: "delete"; workId: WorkId; previousCurrentWorkId: WorkId | null }
  | { command: "update"; workId: WorkId; state: WorkReceiptState }
  | { command: "restore"; workId: WorkId }
  | { command: "switch"; workId: WorkId };

export type WorkReceipt = {
  operation: "create" | "update" | "delete" | "switch";
  category: "mutate" | "binding";
  changed: boolean;
  workId: WorkId;
  workName: string;
  before: WorkReceiptState | null;
  after: WorkReceiptState | null;
  inverse: WorkReceiptInverse | null;
};

export function parseWorkReceipt(value: unknown): WorkReceipt | null {
  const receipt = record(value);
  if (!receipt) return null;
  const operation = receipt.operation;
  if (
    operation !== "create" &&
    operation !== "update" &&
    operation !== "delete" &&
    operation !== "switch"
  ) {
    return null;
  }
  const expectedCategory: WorkReceipt["category"] = operation === "switch" ? "binding" : "mutate";
  if (receipt.category !== expectedCategory) return null;
  if (typeof receipt.changed !== "boolean") return null;
  if (typeof receipt.workId !== "string" || typeof receipt.workName !== "string") return null;
  const before = receipt.before === null ? null : parseState(receipt.before);
  const after = receipt.after === null ? null : parseState(receipt.after);
  if (receipt.before !== null && !before) return null;
  if (receipt.after !== null && !after) return null;
  const inverse = receipt.inverse === null ? null : parseInverse(receipt.inverse);
  if (receipt.inverse !== null && !inverse) return null;
  if (receipt.changed !== (inverse !== null)) return null;
  return {
    operation,
    category: expectedCategory,
    changed: receipt.changed,
    workId: receipt.workId as WorkId,
    workName: receipt.workName,
    before,
    after,
    inverse,
  };
}

function parseState(value: unknown): WorkReceiptState | null {
  const state = record(value);
  if (!state) return null;
  if (
    typeof state.name !== "string" ||
    (state.goal !== null && typeof state.goal !== "string") ||
    (state.description !== null && typeof state.description !== "string") ||
    (state.status !== "active" && state.status !== "archived")
  ) {
    return null;
  }
  return {
    name: state.name,
    goal: state.goal,
    description: state.description,
    status: state.status,
  };
}

function parseInverse(value: unknown): WorkReceiptInverse | null {
  const inverse = record(value);
  if (!inverse || typeof inverse.workId !== "string") return null;
  switch (inverse.command) {
    case "delete":
      return inverse.previousCurrentWorkId === null ||
        typeof inverse.previousCurrentWorkId === "string"
        ? {
            command: "delete",
            workId: inverse.workId as WorkId,
            previousCurrentWorkId: inverse.previousCurrentWorkId as WorkId | null,
          }
        : null;
    case "update": {
      const state = parseState(inverse.state);
      return state ? { command: "update", workId: inverse.workId as WorkId, state } : null;
    }
    case "restore":
      return { command: "restore", workId: inverse.workId as WorkId };
    case "switch":
      return { command: "switch", workId: inverse.workId as WorkId };
    default:
      return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
