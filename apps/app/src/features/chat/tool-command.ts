/** Maps tool views to writer-facing commands and labels. */
import type { Block, JsonValue } from "@meridian/contracts/protocol";
import { parseWorkReceipt, type WorkReceipt } from "@meridian/contracts/works";
import { groupDeliverySegments, type ToolView } from "./group-delivery-segments";

export type WriteMode = "direct" | "draft";

export type ToolCommand =
  | "read"
  | "skim"
  | "create"
  | "copy"
  | "edit"
  | "undo"
  | "redo"
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
    case "read":
      return stringInput(toolInputObject(tool), "format") === "outline" ? "skim" : "read";
    case "write":
      return writeCommand(toolInputObject(tool));
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

/**
 * The writer-facing verb for one `write` call. Removing blocks is an edit. A
 * `copy`, or an `insert`/`replace` that takes its blocks from `from`, is a copy:
 * saying it wrote text would hide where the words came from. A call whose
 * command hasn't streamed in yet reads as writing; a command this list doesn't
 * know (an old row's `write(command: "read")`, say) is `unknown`.
 */
function writeCommand(input: Record<string, JsonValue>): ToolCommand {
  const command = stringInput(input, "command");
  switch (command) {
    case "create":
      return "create";
    case "copy":
      return "copy";
    case "insert":
    case "replace":
      return copySourcePath(input) ? "copy" : "edit";
    case "remove":
      return "edit";
    case "undo":
      return "undo";
    case "redo":
      return "redo";
    default:
      return command ? "unknown" : "create";
  }
}

/** The document a `write` call copies from, as the model named it (`from.path`). */
export function copySourcePath(input: Record<string, JsonValue>): string | undefined {
  const from = input.from;
  if (!from || typeof from !== "object" || Array.isArray(from)) return undefined;
  return stringInput(from as Record<string, JsonValue>, "path");
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
