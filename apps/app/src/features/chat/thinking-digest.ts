/**
 * Deterministic, presentation-only summary of tool operations hidden by one
 * process fold. The digest never describes visible text or artifacts.
 *
 * `countFoldTools` holds the counting rule as a pure, macro-free core so it can
 * be unit-tested; `thinkingDigest` only formats its result.
 */
import { i18n } from "@lingui/core";
import { plural, t } from "@lingui/core/macro";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { ToolView } from "./group-delivery-segments";
import {
  humanizeSkillSlug,
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

export function countFoldTools(tools: readonly ToolView[]): FoldToolCounts {
  const invokedSkills = new Set<string>();
  const readDocuments = new Set<string>();
  let steps = 0;

  for (const tool of tools) {
    const path = stringInput(toolInputObject(tool), "path");
    // Successful writes belong to the turn receipt, not the process digest.
    const command = toolCommand(tool);
    const skill = stringInput(toolInputObject(tool), "name");

    if (!tool.isError && command === "skill" && skill) {
      invokedSkills.add(skill);
      continue;
    }
    // A skill's own files are not the writer's documents; reading one is a step.
    if (!tool.isError && path && isReadCommand(command) && !skillFile(path)) {
      readDocuments.add(documentIdentity(path));
      continue;
    }
    if (!tool.isError && path && isEditCommand(command)) {
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

export function thinkingDigest(tools: readonly ToolView[]): string | null {
  const { invokedSkills, readDocuments, steps } = countFoldTools(tools);
  const clauses: string[] = [];

  if (invokedSkills.size > 0) {
    // The quotes ride inside the value: an apostrophe in an ICU message
    // escapes the placeholder next to it.
    const skills = new Intl.ListFormat(i18n.locale || undefined, {
      style: "long",
      type: "conjunction",
    }).format([...invokedSkills].map((slug) => `'${humanizeSkillSlug(slug)}'`));
    clauses.push(t`Invoked ${skills}`);
  }

  if (readDocuments.size > 0) {
    clauses.push(
      plural(readDocuments.size, {
        one: "read # document",
        other: "read # documents",
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
