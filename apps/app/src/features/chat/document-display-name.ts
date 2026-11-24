import { t } from "@lingui/core/macro";
import { splitDocumentHrefSuffix } from "@meridian/contracts";
import {
  documentTitleFromUri,
  type ParsedContextAuthority,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import { type ProjectContextTreeScheme, readSegment } from "@meridian/contracts/protocol";
import { humanizeSkillSlug, skillFile } from "@meridian/thread-client";
import { areaOf, schemeLabel } from "@/features/project/context/context-schemes";

export type ContextOwner = Extract<ParsedContextAuthority, { kind: "work" | "lineage" | "chat" }>;

export type OwnerNames = (
  owner: ContextOwner | { kind: "work-id"; workId: string },
) => string | null;

export const noOwnerNames: OwnerNames = () => null;

export type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme | null;
  path: string;
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

function draftId(owner: ContextOwner | null | undefined): string {
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

function inArea(
  scheme: ProjectContextTreeScheme,
  owner: ContextOwner | null | undefined,
  names: OwnerNames,
  path: string,
) {
  const name = owner ? names(owner) : null;
  if (name && scheme === "scratch") return `${t`Scratch for ${name}`}/${path}`;
  if (name && scheme === "uploads") return `${t`Uploads for ${name}`}/${path}`;
  const { area, rest } = areaOf(scheme, path);
  return `${area}/${rest}`;
}

const folderOf = (path: string) => {
  const trimmed = path.replace(/^\/+/, "");
  return trimmed.slice(0, trimmed.lastIndexOf("/") + 1);
};

export function documentDisplayName(uriOrPath: string): string {
  const skillFileName = skillFileDisplayName(uriOrPath);
  if (skillFileName) return skillFileName;
  const { path } = parseContextLocation(uriOrPath);
  return documentTitleFromUri(path) ?? t`Untitled document`;
}

function skillFileDisplayName(uriOrPath: string): string | null {
  const file = skillFile(uriOrPath);
  if (!file) return null;
  const name = documentTitleFromUri(file.path) ?? file.path;
  const skill = humanizeSkillSlug(file.skill);
  return t`${name} (${skill})`;
}

export function describeModelMove(from: string, to: string, names?: OwnerNames) {
  return describeMove(
    parseContextLocation(from),
    parseContextLocation(to),
    documentDisplayName(to),
    names,
  );
}

export function describeMove(
  source: ParsedContextLocation,
  destination: ParsedContextLocation,
  name = documentTitleFromUri(destination.path) ?? t`Untitled document`,
  names: OwnerNames = noOwnerNames,
): { kind: "rename" | "move" | "reorder"; place: string } {
  const path = `${folderOf(destination.path)}${name}`;
  const otherArea =
    destination.scheme !== null &&
    (source.scheme !== destination.scheme || draftId(source.owner) !== draftId(destination.owner));
  if (otherArea && destination.scheme)
    return {
      kind: "move",
      place: inArea(destination.scheme, destination.owner, names, path),
    };
  if (folderOf(source.path) !== folderOf(destination.path)) return { kind: "move", place: path };
  return source.path === destination.path
    ? { kind: "reorder", place: name }
    : { kind: "rename", place: name };
}

export function documentLocationName(uriOrPath: string, names: OwnerNames = noOwnerNames): string {
  const location = parseContextLocation(uriOrPath);
  const path = `${folderOf(location.path)}${documentDisplayName(uriOrPath)}`;
  return location.scheme ? inArea(location.scheme, location.owner, names, path) : path;
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const place = scheme ? areaOf(scheme, path) : null;
  if (place && place.area !== (scheme && schemeLabel(scheme)) && !place.rest) return place.area;
  const segment = path.split("/").filter(Boolean).at(-1);
  return segment !== undefined
    ? readSegment(segment).name
    : scheme
      ? schemeLabel(scheme)
      : t`Untitled document`;
}
