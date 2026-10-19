/**
 * What one process fold's visible tools did, as counts. The app words them
 * (`thinkingDigest`, with Lingui) and `./mf` prints them plainly; the counting
 * rule lives here once and never describes visible text or artifacts.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ToolView } from "./group-delivery-segments";
import {
  documentToolFailed,
  skillFile,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
} from "./tool-command";

export type FoldToolCounts = {
  /** Skill slugs the fold loaded, in call order. */
  invokedSkills: Set<string>;
  readDocuments: Set<string>;
  steps: number;
};

/** `FoldToolCounts` as plain numbers: what the view model carries and `./mf` prints. */
export type FoldDigest = {
  /** Skill slugs the fold loaded, in call order. */
  invokedSkills: string[];
  readDocuments: number;
  steps: number;
};

export function foldDigest(tools: readonly ToolView[]): FoldDigest {
  const counts = countFoldTools(tools);
  return {
    invokedSkills: [...counts.invokedSkills],
    readDocuments: counts.readDocuments.size,
    steps: counts.steps,
  };
}

export function countFoldTools(tools: readonly ToolView[]): FoldToolCounts {
  const invokedSkills = new Set<string>();
  const readDocuments = new Set<string>();
  let steps = 0;

  for (const tool of tools) {
    const resultPath =
      tool.result && typeof tool.result === "object" && !Array.isArray(tool.result)
        ? stringInput(tool.result, "path")
        : undefined;
    const path = resultPath ?? stringInput(toolInputObject(tool), "path");
    // Successful writes belong to the turn receipt, not the process digest.
    const command = toolCommand(tool);
    const skill = stringInput(toolInputObject(tool), "name");

    if (!documentToolFailed(tool) && command === "skill" && skill) {
      invokedSkills.add(skill);
      continue;
    }
    // A skill's own files are not the writer's documents; reading one is a step.
    if (!documentToolFailed(tool) && path && isReadCommand(command) && !skillFile(path)) {
      const identity = documentIdentity(path);
      if (identity) readDocuments.add(identity);
      continue;
    }
    if (!documentToolFailed(tool) && path && isEditCommand(command)) {
      continue;
    }
    // Failed, non-document (`search`, `ls`, `work`, a `skills://` read) and
    // pathless operations are uncountable: they contribute a step instead.
    steps += 1;
  }

  return { invokedSkills, readDocuments, steps };
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

function documentIdentity(uriOrPath: string): string | null {
  // A section address (`path#fragment`) names the same document as its path.
  const marker = uriOrPath.indexOf("#");
  const filePath = marker === -1 ? uriOrPath : uriOrPath.slice(0, marker);
  const parsed = parseContextUri(filePath);
  return parsed.ok ? parsed.value.normalized : parsed.error.unresolvedVariable ? null : filePath;
}
