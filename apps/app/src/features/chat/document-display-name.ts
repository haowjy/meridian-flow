/**
 * Writer-facing names for context documents and folders shown in chat.
 *
 * This module turns tool addresses into story objects. It owns no lookup or
 * state: context URIs already carry the document basename and location, and an
 * owner's name (a Work's, a chat's) comes from the caller's `OwnerNames`.
 */
import { t } from "@lingui/core/macro";
import { splitDocumentHrefSuffix } from "@meridian/contracts";
import {
  documentTitleFromUri,
  type ParsedContextAuthority,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { humanizeSkillSlug, skillFile } from "@meridian/thread-client";
import { schemeLabel } from "@/features/project/context/context-schemes";

/** A Scratch or Uploads owner an address names by handle: a Work, a chat's lineage, or a chat. */
export type ContextOwner = Extract<ParsedContextAuthority, { kind: "work" | "lineage" | "chat" }>;

/**
 * The writer's name for an owner an address names by handle: the Work's name or the chat's
 * title, never the handle (#914). Null while it is unknown.
 */
export type OwnerNames = (owner: ContextOwner) => string | null;

export const noOwnerNames: OwnerNames = () => null;

export type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme | null;
  path: string;
  /** Who owns a Scratch or Uploads document, when its address names them. */
  owner?: ContextOwner | null;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const { path } = splitDocumentHrefSuffix(uriOrPath);
  const parsed = parseUnifiedContextUri(path);
  if (!parsed.ok) return { scheme: null, path };
  const { scheme, authority } = parsed.value;
  const owner =
    authority.kind === "work" || authority.kind === "lineage" || authority.kind === "chat"
      ? authority
      : null;
  return { scheme, path: parsed.value.path, owner };
}

function ownerKey(owner: ContextOwner | null | undefined): string {
  switch (owner?.kind) {
    case "work":
      return `work:${owner.workHandle}`;
    case "lineage":
      return `lineage:${owner.rootThreadRef}`;
    case "chat":
      return `chat:${owner.chatRef}`;
    default:
      return "";
  }
}

/** The area a location is in: "Manuscript", or "Scratch for Ascension" when its owner is named. */
function areaName(
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner | null | undefined,
  names: OwnerNames,
) {
  const name = owner ? names(owner) : null;
  if (name && scheme === "scratch") return t`Scratch for ${name}`;
  if (name && scheme === "uploads") return t`Uploads for ${name}`;
  return schemeLabel(scheme);
}

const folderOf = (path: string) => {
  const trimmed = path.replace(/^\/+/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
};

/**
 * The document's name as stored, and nothing else: `Chapter 13`, `outline.json`.
 * Where it lives is not part of what a timeline row claims: the row says what
 * the agent did to a document, and the name's door already goes wherever that
 * document is.
 */
export function documentDisplayName(uriOrPath: string): string {
  const skillFileName = skillFileDisplayName(uriOrPath);
  if (skillFileName) return skillFileName;
  const { path } = parseContextLocation(uriOrPath);
  return documentTitleFromUri(path) ?? t`Untitled document`;
}

/**
 * A skill file says whose it is, "prose-critique (Story Review)": its bare name
 * alone would pass for one of the writer's documents.
 */
function skillFileDisplayName(uriOrPath: string): string | null {
  const file = skillFile(uriOrPath);
  if (!file) return null;
  const name = documentTitleFromUri(file.path) ?? file.path;
  const skill = humanizeSkillSlug(file.skill);
  return t`${name} (${skill})`;
}

/**
 * What a model's move did, as little as tells it apart: for a move, where the document went (its
 * new name for a rename in place; the folder path between folders; the area too between sections
 * or owners); for a reorder, only that its position changed.
 */
export function describeModelMove(from: string, to: string, names?: OwnerNames) {
  return describeMove(
    parseContextLocation(from),
    parseContextLocation(to),
    documentDisplayName(to),
    names,
  );
}

/**
 * A move between two locations: `rename` when only the name changes, `reorder` when nothing the
 * path shows changes (a position among siblings), and where it lands.
 */
export function describeMove(
  source: ParsedContextLocation,
  destination: ParsedContextLocation,
  name = documentTitleFromUri(destination.path) ?? t`Untitled document`,
  names: OwnerNames = noOwnerNames,
): { kind: "rename" | "move" | "reorder"; place: string } {
  const path = `${folderOf(destination.path)}${name}`;
  const otherArea =
    destination.scheme !== null &&
    (source.scheme !== destination.scheme ||
      ownerKey(source.owner) !== ownerKey(destination.owner));
  if (otherArea && destination.scheme)
    return {
      kind: "move",
      place: `${areaName(destination.scheme, destination.owner, names)}/${path}`,
    };
  if (folderOf(source.path) !== folderOf(destination.path)) return { kind: "move", place: path };
  return source.path === destination.path
    ? { kind: "reorder", place: name }
    : { kind: "rename", place: name };
}

/**
 * Where a document is, whole: "Manuscript/part2/note", "Scratch for Ascension/note". A
 * refusal names this, so the writer can find what stands in the way.
 */
export function documentLocationName(uriOrPath: string, names: OwnerNames = noOwnerNames): string {
  const location = parseContextLocation(uriOrPath);
  const path = `${folderOf(location.path)}${documentDisplayName(uriOrPath)}`;
  return location.scheme ? `${areaName(location.scheme, location.owner, names)}/${path}` : path;
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? (scheme ? schemeLabel(scheme) : t`Untitled document`);
}
