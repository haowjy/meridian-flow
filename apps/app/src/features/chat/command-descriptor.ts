/** Maps tool commands to their transcript labels and metadata. */
import { t } from "@lingui/core/macro";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { JsonValue } from "@meridian/contracts/protocol";
import {
  BookOpen,
  Copy,
  FilePlus2,
  FolderInput,
  FolderTree,
  Layers,
  List,
  type LucideIcon,
  PenLine,
  Redo2,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react";

import { documentDisplayName, documentFileName, folderDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import {
  humanizeSkillSlug,
  sourcePath,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
  type WriteMode,
  workReceipt,
} from "./tool-command";
import { workReceiptLine } from "./work-receipt-copy";

export type ToolActivityPhrase = {
  verb: string;
  /**
   * Carries its own trailing ellipsis while in flight, because the ellipsis
   * belongs at the end of the whole phrase rather than after the verb.
   */
  parameter?: string;
};

/** Both tenses of one row's phrase. Tense is protocol state, never timing. */
export type ToolActivityVocabulary = {
  /** Awaiting `tool_response`. */
  active: ToolActivityPhrase;
  /** Result in hand. */
  complete: ToolActivityPhrase;
};

export type CommandExpand =
  /** Nothing worth an affordance. A chevron is a promise. */
  | "none"
  /** The passage the model read, as quoted prose. */
  | "result-preview"
  /** The headings a skim saw, as a list. */
  | "result-outline"
  /** What the model submitted, read from the tool input. */
  | "submitted-content"
  /** Curated per-tool content the registry builds itself. */
  | "renderer";

export type CommandDescriptor = {
  /** One glyph per command. Read down the icon column and the turn has a shape. */
  Icon: LucideIcon;
  phrases: (tool: ToolView, writeMode: WriteMode) => ToolActivityVocabulary;
  /** A failure is its own claim, so it never reuses the success verb. */
  failureVerb: (writeMode: WriteMode) => string;
  /** The complete-tense title when the command named no document. */
  pathlessTitle: ((writeMode: WriteMode) => string) | null;
  expand: CommandExpand;
};

/** A phrase pair with no parameter of its own. */
function tenses(active: string, complete: string): ToolActivityVocabulary {
  return { active: { verb: active }, complete: { verb: complete } };
}

/** Search patterns are the model's words; a long one must not run the row. */
function truncatePattern(pattern: string): string {
  return pattern.length <= 60 ? pattern : `${pattern.slice(0, 59).trimEnd()}…`;
}

function workTenses(tool: ToolView, active: string, complete: string): ToolActivityVocabulary {
  const receipt = workReceipt(tool);
  const line = receipt ? workReceiptLine(receipt) : null;
  return { active: { verb: active }, complete: { verb: line || complete } };
}

const COMMAND_DESCRIPTORS: Record<ToolCommand, CommandDescriptor> = {
  read: {
    Icon: BookOpen,
    phrases: (tool) => documentTenses(tool, t`Reading`, t`Read`),
    failureVerb: () => t`Couldn't read`,
    pathlessTitle: () => t`Read file`,
    expand: "result-preview",
  },
  // An outline read returns heading structure, not prose. A row saying "Read"
  // over that payload claims the model saw the words.
  skim: {
    Icon: List,
    phrases: (tool) => documentTenses(tool, t`Skimming`, t`Skimmed`),
    failureVerb: () => t`Couldn't read`,
    pathlessTitle: () => t`Read file`,
    expand: "result-outline",
  },
  create: {
    Icon: FilePlus2,
    phrases: (tool, writeMode) =>
      documentTenses(
        tool,
        writeMode === "draft" ? t`Drafting` : t`Writing`,
        writeMode === "draft" ? t`Drafted` : t`Wrote`,
      ),
    failureVerb: (writeMode) => (writeMode === "draft" ? t`Couldn't draft` : t`Couldn't write`),
    pathlessTitle: (writeMode) => (writeMode === "draft" ? t`Drafted file` : t`Wrote file`),
    expand: "submitted-content",
  },
  // The destination rides the row's document door, so the verb names the source
  // and the direction: a whole-document copy reads "Copied a.md to", a block
  // copy "Copied from a.md into". The model's `from` stays the only input read.
  copy: {
    Icon: Copy,
    phrases: copyTenses,
    failureVerb: () => t`Couldn't copy`,
    pathlessTitle: () => t`Copied file`,
    expand: "none",
  },
  // A move names where the document came from in the verb and where it went
  // as the parameter, like a whole-document copy.
  move: {
    Icon: FolderInput,
    phrases: moveTenses,
    failureVerb: () => t`Couldn't move`,
    pathlessTitle: () => t`Moved a document`,
    expand: "none",
  },
  delete: {
    Icon: Trash2,
    phrases: (tool) => documentTenses(tool, t`Deleting`, t`Deleted`),
    failureVerb: () => t`Couldn't delete`,
    pathlessTitle: () => t`Deleted a document`,
    expand: "none",
  },
  edit: {
    Icon: PenLine,
    phrases: (tool, writeMode) =>
      documentTenses(
        tool,
        writeMode === "draft" ? t`Drafting` : t`Editing`,
        writeMode === "draft" ? t`Drafted` : t`Edited`,
      ),
    failureVerb: (writeMode) => (writeMode === "draft" ? t`Couldn't draft` : t`Couldn't edit`),
    pathlessTitle: (writeMode) => (writeMode === "draft" ? t`Drafted file` : t`Edited file`),
    expand: "submitted-content",
  },
  // Reverting a change is not editing. Telling a writer their chapter was
  // edited when it was put back is the same over-claim as calling a skim a
  // read, and it holds in draft mode too.
  undo: {
    Icon: Undo2,
    phrases: () => tenses(t`Undoing…`, t`Undid`),
    failureVerb: () => t`Couldn't undo`,
    pathlessTitle: null,
    expand: "none",
  },
  redo: {
    Icon: Redo2,
    phrases: () => tenses(t`Redoing…`, t`Redid`),
    failureVerb: () => t`Couldn't redo`,
    pathlessTitle: null,
    expand: "none",
  },
  search: {
    Icon: Search,
    phrases: (tool) => {
      const input = toolInputObject(tool);
      const pattern = stringInput(input, "query") ?? stringInput(input, "pattern");
      if (!pattern) return tenses(t`Searching…`, t`Searched context`);
      const quoted = `“${truncatePattern(pattern)}”`;
      return {
        active: { verb: t`Searching`, parameter: `${quoted}…` },
        complete: { verb: t`Searched`, parameter: quoted },
      };
    },
    failureVerb: () => t`Couldn't search`,
    pathlessTitle: null,
    expand: "renderer",
  },
  list: {
    Icon: FolderTree,
    phrases: (tool) => {
      const path = stringInput(toolInputObject(tool), "path");
      if (!path) return tenses(t`Exploring folders…`, t`Explored folders`);
      const folder = folderDisplayName(path);
      return {
        active: { verb: t`Exploring`, parameter: `${folder}…` },
        complete: { verb: t`Explored`, parameter: folder },
      };
    },
    failureVerb: () => t`Couldn't explore`,
    pathlessTitle: null,
    expand: "renderer",
  },
  // A `skill` call loads that skill's SKILL.md. The row names the skill, not
  // the file: the writer never opens a skill body as a document.
  skill: {
    Icon: Sparkles,
    phrases: (tool) => {
      const slug = stringInput(toolInputObject(tool), "name");
      if (!slug) return tenses(t`Invoking a skill…`, t`Invoked a skill`);
      // The quotes ride inside the value: an apostrophe in an ICU message
      // escapes the placeholder next to it.
      const skill = `'${humanizeSkillSlug(slug)}'`;
      return tenses(t`Invoking ${skill}…`, t`Invoked ${skill}`);
    },
    failureVerb: () => t`Couldn't run that skill`,
    pathlessTitle: null,
    expand: "none",
  },
  // Work commands manage the writer's Works, never their manuscript, and the
  // whole family wears the Work glyph (Layers — the same mark that rides
  // beside every Work name). Within the family the verb carries the
  // distinction; the glyph answers the icon column's real question, which is
  // whether the agent touched the book.
  "work-read": {
    Icon: Layers,
    phrases: () => tenses(t`Checking Work…`, t`Checked Work`),
    failureVerb: () => t`Couldn't check Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-create": {
    Icon: Layers,
    phrases: (tool) => workTenses(tool, t`Creating a Work…`, t`Created a Work`),
    failureVerb: () => t`Couldn't create a Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-update": {
    Icon: Layers,
    phrases: (tool) => workTenses(tool, t`Updating a Work…`, t`Updated a Work`),
    failureVerb: () => t`Couldn't update that Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-delete": {
    Icon: Layers,
    phrases: (tool) => workTenses(tool, t`Deleting a Work…`, t`Deleted a Work`),
    failureVerb: () => t`Couldn't delete that Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-switch": {
    Icon: Layers,
    phrases: (tool) => workTenses(tool, t`Switching Work…`, t`Switched Work`),
    failureVerb: () => t`Couldn't switch Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  unknown: {
    Icon: Wrench,
    phrases: (tool) => {
      const name = humanizeToolName(tool.toolName);
      return tenses(name, name);
    },
    failureVerb: () => t`Couldn't finish that step`,
    pathlessTitle: null,
    expand: "none",
  },
};

/** A document command's phrases, naming the document it acted on. */
function documentTenses(
  tool: ToolView,
  activeVerb: string,
  completeVerb: string,
): ToolActivityVocabulary {
  const file = documentTarget(toolInputObject(tool));
  if (!file) return tenses(`${activeVerb}…`, completeVerb);
  const name = documentFileName(file);
  return {
    active: { verb: activeVerb, parameter: `${name}…` },
    complete: { verb: completeVerb, parameter: name },
  };
}

/** A copy's phrases: the source in the verb, the destination as the parameter. */
function copyTenses(tool: ToolView): ToolActivityVocabulary {
  const input = toolInputObject(tool);
  const from = sourcePath(input);
  const destination = documentTarget(input);
  if (!from) return documentTenses(tool, t`Copying`, t`Copied`);
  const source = documentFileName(from);
  const wholeDocument = stringInput(input, "command") === "copy";
  const active = wholeDocument ? t`Copying ${source} to` : t`Copying from ${source} into`;
  const complete = wholeDocument ? t`Copied ${source} to` : t`Copied from ${source} into`;
  if (!destination) return tenses(`${active}…`, complete);
  const name = documentFileName(destination);
  return {
    active: { verb: active, parameter: `${name}…` },
    complete: { verb: complete, parameter: name },
  };
}

/**
 * A move's phrases: the document in the verb, where it went as the parameter.
 * Names follow a read row's: file names while it runs, titles once done.
 */
function moveTenses(tool: ToolView): ToolActivityVocabulary {
  const input = toolInputObject(tool);
  const from = sourcePath(input);
  const destination = documentTarget(input);
  if (!from) return documentTenses(tool, t`Moving`, t`Moved`);
  const active = movingVerb(documentFileName(from));
  const complete = movedVerb(documentDisplayName(from));
  if (!destination) return tenses(`${active}…`, complete);
  const activePlace = moveDestinationName(from, destination, documentFileName);
  return {
    active: { verb: active, parameter: `${activePlace}…` },
    complete: {
      verb: complete,
      parameter: moveDestinationName(from, destination, documentDisplayName),
    },
  };
}

function movingVerb(source: string): string {
  return t`Moving ${source} to`;
}

function movedVerb(source: string): string {
  return t`Moved ${source} to`;
}

/**
 * Where a move put the document, named by `name`. A rename keeps its folder,
 * so the new name says it all; a move to another folder keeps its name, so
 * the folder's path in front of it tells the writer where it went.
 */
export function moveDestinationName(
  from: string,
  to: string,
  name: (uriOrPath: string) => string,
): string {
  const destination = contextLocation(to);
  if (contextLocation(from).folder === destination.folder) return name(to);
  const folder = destination.path.slice(0, destination.path.lastIndexOf("/") + 1);
  return `${folder}${name(to)}`;
}

/** A document's path without its scheme, and the folder it sits in (scheme included). */
function contextLocation(uriOrPath: string): { path: string; folder: string } {
  const parsed = parseUnifiedContextUri(uriOrPath);
  const scheme = parsed.ok ? parsed.value.scheme : "";
  const path = (parsed.ok ? parsed.value.path : uriOrPath).replace(/^\/+/, "");
  const slash = path.lastIndexOf("/");
  return { path, folder: `${scheme}:${slash < 0 ? "" : path.slice(0, slash)}` };
}

function documentTarget(input: Record<string, JsonValue>): string | undefined {
  return stringInput(input, "path") ?? stringInput(input, "uri") ?? stringInput(input, "file");
}

export function descriptorFor(tool: ToolView): CommandDescriptor {
  return COMMAND_DESCRIPTORS[toolCommand(tool)];
}

/** Arguments are developer detail and never enter a title. */
export function humanizeToolName(toolName: string): string {
  const words = toolName.replaceAll("_", " ");
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : words;
}

/** The phrase for the tool's current protocol state, never guessed from timing. */
export function toolActivityPhrase(
  tool: ToolView,
  writeMode: WriteMode = "direct",
): ToolActivityPhrase {
  const vocabulary = descriptorFor(tool).phrases(tool, writeMode);
  return tool.status === "complete" ? vocabulary.complete : vocabulary.active;
}

/** Flattens a phrase for the screen reader, which hears no typography. */
export function toolActivityAnnouncement(phrase: ToolActivityPhrase): string {
  return phrase.parameter ? `${phrase.verb} ${phrase.parameter}` : phrase.verb;
}

/** Shared writer-facing label for a live tool dispatch (same vocabulary as ToolRow). */
export function liveToolActivityLabel(toolName: string, input: unknown): string {
  const tool: ToolView = {
    toolCallId: null,
    toolName,
    input: (input ?? null) as ToolView["input"],
    result: null,
    status: "partial",
    isError: false,
    message: null,
    streamedOutput: null,
    metadata: null,
    keyBlock: {} as ToolView["keyBlock"],
  };
  return toolActivityAnnouncement(toolActivityPhrase(tool));
}
