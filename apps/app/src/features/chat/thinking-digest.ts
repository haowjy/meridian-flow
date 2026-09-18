/**
 * Deterministic, presentation-only summary of tool operations hidden by one
 * process fold. The digest never describes visible text or artifacts.
 *
 * `countFoldTools` holds the counting rule as a pure, macro-free core so it can
 * be unit-tested; `thinkingDigest` only formats its result.
 */
import { plural, t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";

export type ThinkingDigestWriteMode = "direct" | "draft";

export type FoldToolCounts = {
  readDocuments: Set<string>;
  editedDocuments: Set<string>;
  steps: number;
};

export function countFoldTools(tools: readonly ToolView[]): FoldToolCounts {
  const readDocuments = new Set<string>();
  const editedDocuments = new Set<string>();
  let steps = 0;

  for (const tool of tools) {
    const input = inputObject(tool);
    const command = stringField(input, "command");
    const path = stringField(input, "path");
    const isWrite = tool.toolName === "write";

    if (!tool.isError && isWrite && path) {
      if (command === "read") readDocuments.add(documentIdentity(path));
      else editedDocuments.add(documentIdentity(path));
      continue;
    }
    // Failed, non-write (`search`, `ls`, `work`), and pathless operations are
    // uncountable: they contribute a step instead of a document.
    steps += 1;
  }

  return { readDocuments, editedDocuments, steps };
}

export function thinkingDigest(
  tools: readonly ToolView[],
  writeMode: ThinkingDigestWriteMode,
): string | null {
  const { readDocuments, editedDocuments, steps } = countFoldTools(tools);
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
  if (steps > 0) {
    clauses.push(
      plural(steps, {
        one: "# step",
        other: "# steps",
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
  return parsed.ok ? parsed.value.normalized : uriOrPath;
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
