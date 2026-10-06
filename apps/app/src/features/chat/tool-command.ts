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
  | "move"
  | "delete"
  | "edit"
  | "undo"
  | "redo"
  | "search"
  | "list"
  | "skill"
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
    case "skill":
      return "skill";
    case "work":
      return workToolCommand(tool);
    default:
      return "unknown";
  }
}

/** The server's facts for one `work` mutation (Work names before and after, never slugs) and the inverse that would undo it; the app writes the line from them. */
export type { WorkReceipt } from "@meridian/contracts/works";

export function workReceipt(tool: ToolView): WorkReceipt | null {
  return parseWorkReceipt(tool.metadata?.workReceipt);
}

/**
 * The document a read or write acted on, by id, from the server's revision
 * evidence. A door with it follows the document after a later move.
 */
export function toolDocumentId(tool: ToolView): string | undefined {
  const revisions = tool.metadata?.documentRevisions;
  if (!Array.isArray(revisions) || revisions.length !== 1) return undefined;
  const [revision] = revisions;
  if (!revision || typeof revision !== "object" || Array.isArray(revision)) return undefined;
  return typeof revision.documentId === "string" ? revision.documentId : undefined;
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
  // The receipt is the server's record of what changed, so its operation wins;
  // a result-only view has no input to classify from.
  const command = workReceipt(tool)?.operation ?? stringInput(toolInputObject(tool), "command");
  switch (command) {
    case "list":
    case "show":
      return "work-read";
    case "switch":
      return "work-switch";
    case "create":
      return "work-create";
    case "update":
      return "work-update";
    case "delete":
      return "work-delete";
    default:
      return "unknown";
  }
}

/**
 * The writer-facing verb for one `write` call. Removing blocks is an edit. A
 * `copy`, or an `insert`/`replace` that takes its blocks from `from`, is a copy:
 * saying it wrote text would hide where the words came from. `move` and
 * `delete` change where a whole document lives, not what it says. A call whose
 * command hasn't streamed in yet reads as writing; a command this list doesn't
 * know is `unknown`.
 */
function writeCommand(input: Record<string, JsonValue>): ToolCommand {
  const command = stringInput(input, "command");
  switch (command) {
    case "create":
      return "create";
    case "copy":
      return "copy";
    case "move":
      return "move";
    case "delete":
      return "delete";
    case "insert":
    case "replace":
      return sourcePath(input) ? "copy" : "edit";
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

/** The document a `write` call takes from, as the model named it (`from.path`): a copy's source, or the document a move moves. */
export function sourcePath(input: Record<string, JsonValue>): string | undefined {
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

/** A file inside a skill package: `skills://<skill>/<path>`. */
type SkillFile = { skill: string; path: string };

/**
 * The skill a `skills://` path belongs to, and the file's path inside it.
 * `skills://` addresses no writer document, so it never parses as a context URI.
 */
export function skillFile(path: string): SkillFile | null {
  const match = path.trim().match(/^skills:\/\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { skill: match[1], path: match[2] };
}

export function humanizeSkillSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
