/** Maps tool views to writer-facing commands and labels. */
import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { parseWorkReceipt, type WorkReceipt } from "@meridian/contracts/works";
import { groupDeliverySegments, type ToolView } from "./group-delivery-segments";

export type WriteMode = "direct" | "draft";

export type ToolCommand =
  | "read"
  | "skim"
  | "create"
  | "edit"
  | "undo"
  | "redo"
  | "review"
  | "search"
  | "list"
  | "invoke"
  | "work-read"
  | "work-create"
  | "work-update"
  | "work-delete"
  | "work-switch"
  | "unknown";

export function toolCommand(tool: ToolView): ToolCommand {
  switch (tool.toolName) {
    case "write":
      return documentCommand(toolInputObject(tool));
    case "search":
      return "search";
    case "ls":
      return "list";
    case "invoke":
      return "invoke";
    case "work":
      return workToolCommand(tool);
    default:
      return "unknown";
  }
}

/** The server's receipt for one `work` command: its category, one factual line already written in Work names (never slugs), and — for mutations — the inverse that would put things.... */
export type { WorkReceipt } from "@meridian/contracts/works";

export function workReceipt(tool: ToolView): WorkReceipt | null {
  return parseWorkReceipt(tool.metadata?.workReceipt);
}

/** Every factual Work receipt a turn's tool results carry, in block order. */
export function turnWorkReceipts(blocks: Block[]): WorkReceipt[] {
  return groupDeliverySegments(blocks).flatMap((segment) => {
    if (segment.kind === "tool") return workReceiptOrNone(segment.tool);
    if (segment.kind === "tool-run") return segment.tools.flatMap(workReceiptOrNone);
    return [];
  });
}

function workReceiptOrNone(tool: ToolView): WorkReceipt[] {
  const receipt = workReceipt(tool);
  return receipt ? [receipt] : [];
}

function workToolCommand(tool: ToolView): ToolCommand {
  const command = stringInput(toolInputObject(tool), "command");
  // The receipt's category is the server's own classification of what
  // happened, so it wins when present — a result-only view has no input to
  // classify from. The input command then refines a mutation to its exact
  // claim; without it a mutation stays at the update verb, which the receipt
  // line corrects on screen anyway.
  const category = workReceipt(tool)?.category ?? workCategoryFromInput(command);
  if (category === "read") return "work-read";
  if (category === "binding") return "work-switch";
  if (category !== "mutate") return "unknown";
  if (command === "create") return "work-create";
  if (command === "delete") return "work-delete";
  return "work-update";
}

function workCategoryFromInput(
  command: string | undefined,
): WorkReceipt["category"] | "read" | null {
  switch (command) {
    case "list":
    case "show":
      return "read";
    case "switch":
      return "binding";
    case "create":
    case "update":
    case "delete":
      return "mutate";
    default:
      return null;
  }
}

function documentCommand(input: Record<string, JsonValue>): ToolCommand {
  switch (stringInput(input, "command")) {
    case "read":
      return stringInput(input, "format") === "outline" ? "skim" : "read";
    case "create":
      return "create";
    case "insert":
    case "replace":
    case "delete":
      return "edit";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    case "diff":
      return "review";
    default:
      return "unknown";
  }
}

export function toolInputObject(tool: ToolView): Record<string, JsonValue> {
  const raw = tool.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, JsonValue>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, JsonValue>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function stringInput(input: Record<string, JsonValue>, field: string): string | undefined {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function humanizeSkillSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
