/** Shared writer vocabulary for visible and announced tool activity. */
import { t } from "@lingui/core/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export type ToolActivityVocabulary = { active: string };

export function toolActivityVocabulary(
  tool: ToolView,
  writeMode: "direct" | "draft" = "direct",
): ToolActivityVocabulary | null {
  const input = toolInputObject(tool);
  if (tool.toolName === "write") {
    const command = stringInput(input, "command");
    if (command === "read") return { active: t`Reading…` };
    if (writeMode === "draft") return { active: t`Drafting…` };
    return {
      active: ["insert", "replace", "undo", "redo"].includes(command ?? "")
        ? t`Editing…`
        : t`Writing…`,
    };
  }
  if (tool.toolName === "ls") return { active: t`Exploring folders…` };
  if (tool.toolName === "grep") return { active: t`Searching…` };
  if (tool.toolName === "invoke") {
    const slug = stringInput(input, "skillname");
    return {
      active: slug ? t`Running the ${humanizeSkillSlug(slug)} skill…` : t`Running skill…`,
    };
  }
  return null;
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
