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

type ParsedContextLocation = {
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

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? (scheme ? schemeLabel(scheme) : t`Untitled document`);
}
