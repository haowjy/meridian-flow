/**
 * Deterministic, presentation-only summary of tool operations hidden by one
 * process fold. The digest never describes visible frontier rows.
 */
import { plural } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue } from "@meridian/contracts/protocol";
import { isContextUri } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import { normalizeToolResultRows } from "./tool-result-preview";

export type ThinkingDigestWriteMode = "direct" | "draft";

export function thinkingDigest(
  tools: readonly ToolView[],
  writeMode: ThinkingDigestWriteMode,
): string | null {
  const exploredDocuments = new Set<string>();
  const editedDocuments = new Set<string>();

  for (const tool of tools) {
    const input = inputObject(tool);
    const command = stringField(input, "command");
    const path = stringField(input, "path");

    if (tool.isError) {
      continue;
    }
    if (tool.toolName === "write" && command === "read") {
      if (path) exploredDocuments.add(documentIdentity(path));
    } else if (tool.toolName === "grep") {
      const resultDocuments = normalizeToolResultRows(tool.output ?? undefined)
        .map((row) => row.title)
        .filter(isContextUri);
      if (resultDocuments.length > 0) {
        for (const uri of resultDocuments) exploredDocuments.add(documentIdentity(uri));
      }
    } else if (tool.toolName === "write") {
      if (path) editedDocuments.add(documentIdentity(path));
    }
  }

  const clauses: string[] = [];
  if (exploredDocuments.size > 0) {
    clauses.push(
      plural(exploredDocuments.size, {
        one: "explored # document",
        other: "explored # documents",
      }),
    );
  }
  if (editedDocuments.size > 0) {
    clauses.push(
      writeMode === "draft"
        ? plural(editedDocuments.size, {
            one: "drafted # document",
            other: "drafted # documents",
          })
        : plural(editedDocuments.size, {
            one: "edited # document",
            other: "edited # documents",
          }),
    );
  }

  const digest = clauses.join(", ");
  return digest ? capitalizeFirst(digest) : null;
}

function inputObject(tool: ToolView): Record<string, JsonValue> {
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

function stringField(input: Record<string, JsonValue>, field: string): string | null {
  const value = input[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function documentIdentity(uriOrPath: string): string {
  const parsed = parseContextUri(uriOrPath);
  return parsed.ok ? parsed.value.canonical : uriOrPath;
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
