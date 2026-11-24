import { plural, t } from "@lingui/core/macro";
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import {
  agentsSaved,
  documentToolFailed,
  documentToolReturned,
  humanizeSkillSlug,
  mcpCall,
  mcpDescribed,
  sourcePath,
  stringInput,
  type ToolCommand,
  toolCommand,
  toolInputObject,
  workReceipt,
} from "@meridian/thread-client";
import {
  BookOpen,
  Code,
  Copy,
  FilePlus2,
  FolderInput,
  FolderTree,
  Layers,
  List,
  type LucideIcon,
  PenLine,
  Plug,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
} from "lucide-react";
import {
  describeModelMove,
  documentDisplayName,
  folderDisplayName,
  type OwnerNames,
} from "./document-display-name";
import { scriptPhrase } from "./script-copy";
import { workReceiptLine } from "./work-receipt-copy";

export type ToolActivityPhrase = {
  verb: string;
  parameter?: string;
};

export type ToolActivityVocabulary = {
  active: ToolActivityPhrase;
  complete: ToolActivityPhrase;
};

export type CommandExpand =
  | "none"
  | "result-preview"
  | "result-outline"
  | "submitted-content"
  | "renderer";

export type CommandDescriptor = {
  Icon: LucideIcon;
  phrases: (tool: ToolView, names?: OwnerNames) => ToolActivityVocabulary;
  failureVerb: () => string;
  pathlessTitle: (() => string) | null;
  expand: CommandExpand;
};

function tenses(active: string, complete: string): ToolActivityVocabulary {
  return { active: { verb: active }, complete: { verb: complete } };
}

function truncatePattern(pattern: string): string {
  return pattern.length <= 60 ? pattern : `${pattern.slice(0, 59).trimEnd()}…`;
}

function workTenses(
  tool: ToolView,
  names: OwnerNames | undefined,
  active: string,
  complete: string,
): ToolActivityVocabulary {
  const receipt = workReceipt(tool);
  const line = receipt ? workReceiptLine(receipt, names) : null;
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
  skim: {
    Icon: List,
    phrases: (tool) => documentTenses(tool, t`Skimming`, t`Skimmed`),
    failureVerb: () => t`Couldn't read`,
    pathlessTitle: () => t`Read file`,
    expand: "result-outline",
  },
  create: {
    Icon: FilePlus2,
    phrases: (tool) => documentTenses(tool, t`Writing`, t`Edited`),
    failureVerb: () => t`Couldn't write`,
    pathlessTitle: () => t`Edited file`,
    expand: "submitted-content",
  },
  copy: {
    Icon: Copy,
    phrases: copyTenses,
    failureVerb: () => t`Couldn't copy`,
    pathlessTitle: () => t`Copied file`,
    expand: "none",
  },
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
    phrases: (tool) => documentTenses(tool, t`Editing`, t`Edited`),
    failureVerb: () => t`Couldn't edit`,
    pathlessTitle: () => t`Edited file`,
    expand: "submitted-content",
  },
  undo: {
    Icon: Undo2,
    phrases: () => tenses(t`Undoing…`, t`Undid`),
    failureVerb: () => t`Couldn't undo`,
    pathlessTitle: null,
    expand: "none",
  },
  grep: {
    Icon: Search,
    phrases: (tool) => {
      const input = toolInputObject(tool);
      const pattern = stringInput(input, "pattern");
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
  skill: {
    Icon: Sparkles,
    phrases: (tool) => {
      const slug = stringInput(toolInputObject(tool), "name");
      if (!slug) return tenses(t`Invoking a skill…`, t`Invoked a skill`);
      // keep: Keep the quotes inside the value; an apostrophe in an ICU message escapes the placeholder beside it.
      const skill = `'${humanizeSkillSlug(slug)}'`;
      return tenses(t`Invoking ${skill}…`, t`Invoked ${skill}`);
    },
    failureVerb: () => t`Couldn't run that skill`,
    pathlessTitle: null,
    expand: "none",
  },
  "work-read": {
    Icon: Layers,
    phrases: () => tenses(t`Checking Work…`, t`Checked Work`),
    failureVerb: () => t`Couldn't check Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-create": {
    Icon: Layers,
    phrases: (tool, names) => workTenses(tool, names, t`Creating a Work…`, t`Created a Work`),
    failureVerb: () => t`Couldn't create a Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-update": {
    Icon: Layers,
    phrases: (tool, names) => workTenses(tool, names, t`Updating a Work…`, t`Updated a Work`),
    failureVerb: () => t`Couldn't update that Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-delete": {
    Icon: Layers,
    phrases: (tool, names) => workTenses(tool, names, t`Deleting a Work…`, t`Deleted a Work`),
    failureVerb: () => t`Couldn't delete that Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "work-switch": {
    Icon: Layers,
    phrases: (tool, names) => workTenses(tool, names, t`Switching Work…`, t`Switched Work`),
    failureVerb: () => t`Couldn't switch Work`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "save-agents": {
    Icon: Save,
    phrases: (tool) => {
      const outcomes = agentsSaved(tool);
      const failed = outcomes.filter((item) => item.outcome === "failed").length;
      const complete =
        failed === 0
          ? t`Saved Agents`
          : failed === outcomes.length
            ? t`Agents not saved`
            : t`Saved Agents, some not saved`;
      return tenses(t`Saving Agents…`, complete);
    },
    failureVerb: () => t`Couldn't save Agents`,
    pathlessTitle: null,
    expand: "none",
  },
  "mcp-call": {
    Icon: Plug,
    phrases: (tool) => {
      const { connection, tool: name } = mcpCall(tool);
      if (!connection || !name) return tenses(t`Using a connection…`, t`Used a connection`);
      const label = mcpToolLabel(connection, name);
      return {
        active: { verb: `${connection}:`, parameter: `${label}…` },
        complete: { verb: `${connection}:`, parameter: label },
      };
    },
    failureVerb: () => t`Couldn't use a connection`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "mcp-run": {
    Icon: Code,
    phrases: (tool) => {
      const active = scriptPhrase(tool);
      return { active, complete: active };
    },
    failureVerb: () => t`Couldn't run a script`,
    pathlessTitle: null,
    expand: "renderer",
  },
  "mcp-describe": {
    Icon: Plug,
    phrases: (tool) => {
      const asked = mcpDescribed(tool);
      const [only] = asked;
      if (asked.length === 1 && only?.connection && !only.tool) {
        const name = only.connection;
        return tenses(t`Reading ${name}’s tools…`, t`Read ${name}’s tools`);
      }
      if (asked.length === 1 && only?.connection && only.tool) {
        const named = `${only.connection}: ${mcpToolLabel(only.connection, only.tool)}`;
        return {
          active: { verb: t`Reading how to use`, parameter: `${named}…` },
          complete: { verb: t`Read how to use`, parameter: named },
        };
      }
      const count = asked.length;
      return tenses(
        t`Reading connection tools…`,
        plural(count, {
          0: "Read connection tools",
          one: "Read how to use # connection tool",
          other: "Read how to use # connection tools",
        }),
      );
    },
    failureVerb: () => t`Couldn't read a connection's tools`,
    pathlessTitle: null,
    expand: "none",
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

function documentTenses(
  tool: ToolView,
  activeVerb: string,
  completeVerb: string,
): ToolActivityVocabulary {
  const file = documentTarget(toolInputObject(tool));
  if (!file) return tenses(`${activeVerb}…`, completeVerb);
  const name = documentDisplayName(file);
  return {
    active: { verb: activeVerb, parameter: `${name}…` },
    complete: { verb: completeVerb, parameter: name },
  };
}

function copyTenses(tool: ToolView): ToolActivityVocabulary {
  const input = toolInputObject(tool);
  const from = sourcePath(input);
  const destination = documentTarget(input);
  if (!from) return documentTenses(tool, t`Copying`, t`Copied`);
  const source = documentDisplayName(from);
  const wholeDocument = stringInput(input, "command") === "copy";
  const active = wholeDocument ? t`Copying ${source} to` : t`Copying from ${source} into`;
  const complete = wholeDocument ? t`Copied ${source} to` : t`Copied from ${source} into`;
  if (!destination) return tenses(`${active}…`, complete);
  const name = documentDisplayName(destination);
  return {
    active: { verb: active, parameter: `${name}…` },
    complete: { verb: complete, parameter: name },
  };
}

export function settledDocumentPath(tool: ToolView): string | undefined {
  const command = toolCommand(tool);
  if (tool.status !== "complete" || (command !== "undo" && command !== "move")) return undefined;
  const result = tool.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return undefined;
  return typeof result.path === "string" && result.path.length > 0 ? result.path : undefined;
}

export function movedTo(tool: ToolView): string | undefined {
  const input = toolInputObject(tool);
  const asked = documentTarget(input);
  const settled = settledDocumentPath(tool);
  if (settled) return settled;
  const from = sourcePath(input);
  if (!asked || !from || !asked.endsWith("/") || from.endsWith("/")) return asked;
  return `${asked}${from.slice(from.lastIndexOf("/") + 1)}`;
}

function moveTenses(tool: ToolView, names?: OwnerNames): ToolActivityVocabulary {
  const input = toolInputObject(tool);
  const from = sourcePath(input);
  const destination = settledDocumentPath(tool) ?? documentTarget(input);
  if (!from) return documentTenses(tool, t`Moving`, t`Moved`);
  const source = documentDisplayName(from);
  const active = t`Moving ${source} to`;
  const complete = copiedOnly(tool) ? t`Copied ${source} to` : t`Moved ${source} to`;
  if (!destination) return tenses(`${active}…`, complete);
  const { kind, place } = describeModelMove(from, destination, names);
  if (kind === "reorder")
    return tenses(t`Changing the position of ${source}…`, t`Changed the position of ${source}`);
  return {
    active: { verb: active, parameter: `${place}…` },
    complete: { verb: complete, parameter: place },
  };
}

function copiedOnly(tool: ToolView): boolean {
  const result = tool.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const tree = result.tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return false;
  const moved = tree.moved;
  const made =
    moved && typeof moved === "object" && !Array.isArray(moved) && typeof moved.made === "number"
      ? moved.made
      : 0;
  return Array.isArray(tree.copied) && tree.copied.length > 0 && made === 0;
}

function documentTarget(input: Record<string, JsonValue>): string | undefined {
  return stringInput(input, "path") ?? stringInput(input, "uri") ?? stringInput(input, "file");
}

export function failureOrReturnedVerb(tool: ToolView): string {
  return documentToolReturned(tool) ? t`Not applied to` : descriptorFor(tool).failureVerb();
}

export function descriptorFor(tool: ToolView): CommandDescriptor {
  return COMMAND_DESCRIPTORS[toolCommand(tool)];
}

export function mcpToolLabel(connection: string, tool: string): string {
  const prefix = new RegExp(`^${connection.replace(/[^A-Za-z0-9]/g, "[_-]?")}[_-]+`, "i");
  const bare = tool.replace(prefix, "") || tool;
  return bare.replace(/[_-]+/g, " ").trim();
}

export function humanizeToolName(toolName: string): string {
  const words = toolName.replaceAll("_", " ");
  return words.length > 0 ? words[0].toUpperCase() + words.slice(1) : words;
}

export function toolActivityPhrase(tool: ToolView, names?: OwnerNames): ToolActivityPhrase {
  const descriptor = descriptorFor(tool);
  if (documentToolFailed(tool)) return { verb: failureOrReturnedVerb(tool) };
  const vocabulary = descriptor.phrases(tool, names);
  return tool.status === "complete" ? vocabulary.complete : vocabulary.active;
}

export function toolActivityAnnouncement(phrase: ToolActivityPhrase): string {
  return phrase.parameter ? `${phrase.verb} ${phrase.parameter}` : phrase.verb;
}

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
    connectionCalls: null,
    metadata: null,
    keyBlock: {} as ToolView["keyBlock"],
  };
  return toolActivityAnnouncement(toolActivityPhrase(tool));
}
