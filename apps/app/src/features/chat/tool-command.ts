/**
 * tool-command — reads a `ToolView` and answers one question: which command is
 * this, in the writer's terms?
 *
 * The writer cares about the command, not the tool that carried it: `write`
 * covers reading, creating, editing, reverting and reviewing, and those are
 * five different things to someone watching their manuscript. Classifying once
 * here means the glyph, the chip tone, the visible verb and the announced verb
 * all derive from one decision and cannot drift apart.
 *
 * What the timeline then *says* about a command lives in
 * `command-descriptor.ts`. Classification stays here so it has no opinion about
 * presentation and no React in its imports.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export type WriteMode = "direct" | "draft";

/**
 * What the agent did, in the writer's terms. `skim` and `read` are one tool
 * argument apart (`format: "outline"`) but a different claim about the book: a
 * skim saw headings, a read saw prose.
 */
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
  | "unknown";

export function toolCommand(tool: ToolView): ToolCommand {
  switch (tool.toolName) {
    case "write":
      return writeCommand(toolInputObject(tool));
    case "search":
      return "search";
    case "ls":
      return "list";
    case "invoke":
      return "invoke";
    default:
      return "unknown";
  }
}

function writeCommand(input: Record<string, JsonValue>): ToolCommand {
  switch (stringInput(input, "command")) {
    case "read":
      return stringInput(input, "format") === "outline" ? "skim" : "read";
    case "create":
      return "create";
    case "insert":
    case "replace":
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
