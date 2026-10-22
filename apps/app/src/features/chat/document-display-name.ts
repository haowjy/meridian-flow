/**
 * Writer-facing names for context documents and folders shown in chat.
 *
 * This module turns tool addresses into story objects. It owns no lookup or
 * state: context URIs already carry the document basename and location.
 */
import { t } from "@lingui/core/macro";
import { splitDocumentHrefSuffix } from "@meridian/contracts";
import { documentTitleFromUri, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { humanizeSkillSlug, skillFile } from "@meridian/thread-client";
import { schemeLabel } from "@/features/project/context/context-schemes";

export type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme | null;
  path: string;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const { path } = splitDocumentHrefSuffix(uriOrPath);
  const parsed = parseUnifiedContextUri(path);
  return parsed.ok ? parsed.value : { scheme: null, path };
}

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
 * Where a move took a document, as little as tells it apart: its new name for a rename in
 * place; the folder path for a move between folders; the section too ("Manuscript/part2/ch4")
 * for a move between sections. Works are never named by handle (#914), so a move between two
 * Works' Scratch reads as a move within Scratch.
 */
export function moveDestinationName(from: string, to: string): string {
  return describeMove(parseContextLocation(from), parseContextLocation(to), documentDisplayName(to))
    .place;
}

/** A move between two locations: `rename` when only the name changes, and where it lands. */
export function describeMove(
  source: ParsedContextLocation,
  destination: ParsedContextLocation,
  name = documentTitleFromUri(destination.path) ?? t`Untitled document`,
): { kind: "rename" | "move"; place: string } {
  const folder = (path: string) => {
    const trimmed = path.replace(/^\/+/, "");
    return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
  };
  const crossSection = source.scheme !== destination.scheme && destination.scheme !== null;
  const path = `${folder(destination.path)}${name}`;
  if (crossSection && destination.scheme)
    return { kind: "move", place: `${schemeLabel(destination.scheme)}/${path}` };
  return folder(source.path) === folder(destination.path)
    ? { kind: "rename", place: name }
    : { kind: "move", place: path };
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? (scheme ? schemeLabel(scheme) : t`Untitled document`);
}
