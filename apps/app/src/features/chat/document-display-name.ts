/**
 * Writer-facing names for context documents and folders shown in chat.
 *
 * This module turns tool addresses into story objects. It owns no lookup or
 * state: context URIs already carry the document basename and location.
 */
import { t } from "@lingui/core/macro";
import {
  documentTitleFromUri,
  type ParsedContextAuthority,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import { schemeLabel } from "@/features/project/context/context-schemes";
import { humanizeSkillSlug, skillFile } from "./tool-command";

type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme;
  path: string;
  authority: ParsedContextAuthority;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const parsed = parseUnifiedContextUri(uriOrPath);
  return parsed.ok
    ? parsed.value
    : { scheme: "manuscript", path: uriOrPath, authority: { kind: "contextual" } };
}

/**
 * The document's name, and nothing else. Where it lives is not part of what a
 * timeline row claims: the row says what the agent did to a document, and the
 * name's door already goes wherever that document is. The one place location
 * still earns its keep is the dead-route pane, which exists to say a document
 * is missing from a particular section.
 */
export function documentDisplayName(uriOrPath: string): string {
  const skillFileName = skillFileDisplayName(uriOrPath);
  if (skillFileName) return skillFileName;
  const { path } = parseContextLocation(uriOrPath);
  return documentTitleFromUri(path) ?? t`Untitled document`;
}

/**
 * Exact file target for tool activity, retaining the extension to disambiguate
 * it. A skill file is named by its skill instead.
 */
export function documentFileName(uriOrPath: string): string {
  const skillFileName = skillFileDisplayName(uriOrPath);
  if (skillFileName) return skillFileName;
  const { path } = parseContextLocation(uriOrPath);
  return path.split("/").filter(Boolean).at(-1) ?? t`Untitled document`;
}

/**
 * A skill file says whose it is, "prose-critique (Story Review)": its bare name
 * alone would pass for one of the writer's documents.
 */
function skillFileDisplayName(uriOrPath: string): string | null {
  const file = skillFile(uriOrPath);
  if (!file) return null;
  const name = documentTitleFromUri(file.path.replace(/#.*$/, "")) ?? file.path;
  const skill = humanizeSkillSlug(file.skill);
  return t`${name} (${skill})`;
}

/** Where a document sits, with its section and explicit Work when requested. */
export function documentLocationPath(uriOrPath: string, qualified = false): string {
  const { scheme, path, authority } = parseContextLocation(uriOrPath);
  const location = path.replace(/^\/+/, "");
  if (!qualified) return location;
  const section = schemeLabel(scheme);
  const work =
    authority.kind === "work"
      ? `@${authority.workSlug}`
      : authority.kind === "none"
        ? t`No Work`
        : null;
  return `${work ? t`${section} (${work})` : section}/${location}`;
}

/** A rename needs only a name; a changed section, Work or folder stays visible. */
export function moveDestinationName(
  from: string,
  to: string,
  name: (uri: string) => string,
): string {
  const source = parseContextLocation(from);
  const destination = parseContextLocation(to);
  const folder = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
  const differentNamespace =
    source.scheme !== destination.scheme ||
    JSON.stringify(source.authority) !== JSON.stringify(destination.authority);
  if (!differentNamespace && folder(source.path) === folder(destination.path)) return name(to);
  const location = documentLocationPath(to, differentNamespace);
  return `${folder(location)}${name(to)}`;
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? schemeLabel(scheme);
}
