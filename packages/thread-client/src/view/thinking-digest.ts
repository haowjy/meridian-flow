/**
 * What one process fold's visible tools did, as counts. The app words them
 * (`thinkingDigest`, with Lingui) and `./mf` prints them plainly; the counting
 * rule lives here once and never describes visible text or artifacts.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { isNotesStepHeldResult } from "@meridian/contracts/threads";
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
  invokedSkills: Set<string>;
  readDocuments: Set<string>;
  steps: number;
};

export type FoldDigest = {
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
    if (isNotesStepHeldResult(tool.result)) {
      steps++;
      continue;
    }
    const path = stringInput(toolInputObject(tool), "path");
    const command = toolCommand(tool);
    const skill = stringInput(toolInputObject(tool), "name");

    if (!documentToolFailed(tool) && command === "skill" && skill) {
      invokedSkills.add(skill);
      continue;
    }
    if (!documentToolFailed(tool) && path && isReadCommand(command) && !skillFile(path)) {
      readDocuments.add(documentIdentity(path));
      continue;
    }
    if (!documentToolFailed(tool) && path && isEditCommand(command)) {
      continue;
    }
    steps += 1;
  }

  return { invokedSkills, readDocuments, steps };
}

function isReadCommand(command: ToolCommand): boolean {
  return command === "read" || command === "skim";
}

function isEditCommand(command: ToolCommand): boolean {
  return (
    command === "create" ||
    command === "copy" ||
    command === "move" ||
    command === "delete" ||
    command === "edit" ||
    command === "undo"
  );
}

function documentIdentity(uriOrPath: string): string {
  const marker = uriOrPath.indexOf("#");
  const filePath = marker === -1 ? uriOrPath : uriOrPath.slice(0, marker);
  const parsed = parseContextUri(filePath);
  return parsed.ok ? parsed.value.normalized : filePath;
}
