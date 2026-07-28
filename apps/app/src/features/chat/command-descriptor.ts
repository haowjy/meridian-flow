/**
 * command-descriptor — everything the timeline says and shows about one
 * command, in one exhaustive table.
 *
 * `tool-command.ts` answers *which command is this*. This module answers *what
 * do we do with it*: the glyph, whether it changed the document, both tenses of
 * its verb, what a failure is called, and what the row says when the command
 * named no document. Those five used to be five switches in three files, so
 * adding a command meant finding all of them and a wrong failure verb was
 * invisible. One entry per command now, and `Record<ToolCommand, ...>` makes a
 * missing entry a type error.
 *
 * Every copy field is a function because Lingui's `t` resolves against the
 * active locale when it runs. A table of top-level strings would freeze the
 * catalog at module load.
 */
import { t } from "@lingui/core/macro";
import {
  BookOpen,
  FilePlus2,
  FolderTree,
  History,
  List,
  type LucideIcon,
  PenLine,
  Redo2,
  Search,
  Sparkles,
  Undo2,
  Wrench,
} from "lucide-react";

import { folderDisplayName } from "./document-display-name";
import type { ToolView } from "./group-delivery-segments";
import {
  humanizeSkillSlug,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
  type WriteMode,
} from "./tool-command";

/**
 * A row title split the way the timeline renders it: the command leads at full
 * ink, and what it acted on follows, quieter. `parameter` is absent when the
 * phrase names nothing the writer would read as a separate thing.
 */
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

/**
 * What a command's row shows behind its chevron. The registry keys expands by
 * tool name, but one `write` tool covers reading, skimming, creating and
 * editing, and those show different things. Naming the shape here keeps that
 * per-command decision beside the command's other policy instead of becoming
 * another switch in a renderer.
 */
export type CommandExpand =
  /** Nothing worth an affordance. A chevron is a promise. */
  | "none"
  /** The passage the model read, as quoted prose. */
  | "output-preview"
  /** The headings a skim saw, as a list. */
  | "output-outline"
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
  /**
   * The complete-tense title when the command named no document. `null` for
   * commands that never name one, whose phrase already reads as a whole
   * sentence.
   */
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

const COMMAND_DESCRIPTORS: Record<ToolCommand, CommandDescriptor> = {
  read: {
    Icon: BookOpen,
    phrases: () => tenses(t`Reading…`, t`Read`),
    failureVerb: () => t`Couldn't read`,
    pathlessTitle: () => t`Read file`,
    expand: "output-preview",
  },
  // An outline read returns heading structure, not prose. A row saying "Read"
  // over that payload claims the model saw the words.
  skim: {
    Icon: List,
    phrases: () => tenses(t`Skimming…`, t`Skimmed`),
    failureVerb: () => t`Couldn't read`,
    pathlessTitle: () => t`Read file`,
    expand: "output-outline",
  },
  create: {
    Icon: FilePlus2,
    phrases: (_tool, writeMode) =>
      writeMode === "draft" ? tenses(t`Drafting…`, t`Drafted`) : tenses(t`Writing…`, t`Wrote`),
    failureVerb: (writeMode) => (writeMode === "draft" ? t`Couldn't draft` : t`Couldn't write`),
    pathlessTitle: (writeMode) => (writeMode === "draft" ? t`Drafted file` : t`Wrote file`),
    expand: "submitted-content",
  },
  edit: {
    Icon: PenLine,
    phrases: (_tool, writeMode) =>
      writeMode === "draft" ? tenses(t`Drafting…`, t`Drafted`) : tenses(t`Editing…`, t`Edited`),
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
  review: {
    Icon: History,
    phrases: () => tenses(t`Checking recent changes…`, t`Checked recent changes`),
    failureVerb: () => t`Couldn't check recent changes`,
    pathlessTitle: null,
    expand: "none",
  },
  search: {
    Icon: Search,
    phrases: (tool) => {
      const pattern = stringInput(toolInputObject(tool), "pattern");
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
  invoke: {
    Icon: Sparkles,
    phrases: (tool) => {
      const slug = stringInput(toolInputObject(tool), "skillname");
      if (!slug) return tenses(t`Invoking a skill…`, t`Invoked a skill`);
      const skill = humanizeSkillSlug(slug);
      return tenses(t`Invoking the ${skill} skill…`, t`Invoked the ${skill} skill`);
    },
    failureVerb: () => t`Couldn't run that skill`,
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
