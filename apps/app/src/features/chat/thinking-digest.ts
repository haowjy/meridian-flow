/**
 * Deterministic, presentation-only summary of tool operations hidden by one
 * process fold. The digest never describes visible text or artifacts.
 *
 * `countFoldTools` holds the counting rule as a pure, macro-free core so it can
 * be unit-tested; `thinkingDigest` only formats its result.
 */
import { plural, t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ToolView } from "./group-delivery-segments";
import { stringInput, type ToolCommand, toolCommand, toolInputObject } from "./tool-command";

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
    const path = stringInput(toolInputObject(tool), "path");
    // `read` calls count as reads and `write` calls as edits. A write command
    // the app doesn't know is a step.
    const command = toolCommand(tool);

    if (!tool.isError && path && isReadCommand(command)) {
      readDocuments.add(documentIdentity(path));
      continue;
    }
    if (!tool.isError && path && isEditCommand(command)) {
      editedDocuments.add(documentIdentity(path));
      continue;
    }
    // Failed, non-document (`search`, `ls`, `work`) and pathless operations
    // are uncountable: they contribute a step instead.
    steps += 1;
  }

  return { readDocuments, editedDocuments, steps };
}

/** A command that only looked at a document. */
function isReadCommand(command: ToolCommand): boolean {
  return command === "read" || command === "skim";
}

/** A command that changed a document, including putting a change back. */
function isEditCommand(command: ToolCommand): boolean {
  return (
    command === "create" ||
    command === "copy" ||
    command === "edit" ||
    command === "undo" ||
    command === "redo"
  );
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

function documentIdentity(uriOrPath: string): string {
  const parsed = parseContextUri(uriOrPath);
  return parsed.ok ? parsed.value.normalized : uriOrPath;
}

function capitalizeFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
