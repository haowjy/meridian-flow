/**
 * Deterministic, presentation-only summary of tool operations hidden by one
 * process fold. The digest never describes visible frontier rows.
 */
import { plural, t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export type ThinkingDigestWriteMode = "direct" | "draft";

export function thinkingDigest(
  tools: readonly ToolView[],
  writeMode: ThinkingDigestWriteMode,
): string | null {
  const readDocuments = new Set<string>();
  const editedDocuments = new Set<string>();

  for (const tool of tools) {
    const input = inputObject(tool);
    const command = stringField(input, "command");
    const path = stringField(input, "path");

    if (tool.isError) {
      continue;
    }
    if (tool.toolName === "write" && command === "read") {
      if (path) readDocuments.add(documentIdentity(path));
    } else if (tool.toolName === "write") {
      if (path) editedDocuments.add(documentIdentity(path));
    }
  }

  const clauses: string[] = [];
  if (readDocuments.size > 0) {
    clauses.push(
      plural(readDocuments.size, {
        one: "read # document",
        other: "read # documents",
      }),
    );
  }
  if (editedDocuments.size > 0) {
    const carryDocumentNoun = readDocuments.size > 0;
    clauses.push(
      writeMode === "draft"
        ? carryDocumentNoun
          ? t`drafted ${editedDocuments.size}`
          : plural(editedDocuments.size, {
              one: "drafted # document",
              other: "drafted # documents",
            })
        : carryDocumentNoun
          ? t`edited ${editedDocuments.size}`
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
