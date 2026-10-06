/**
 * Writer-facing names for context documents and folders shown in chat.
 *
 * This module turns tool addresses into story objects. It owns no lookup or
 * state: context URIs already carry the document basename and location.
 */
import { t } from "@lingui/core/macro";
import { documentTitleFromUri, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import { schemeLabel } from "@/features/project/context/context-schemes";
import { humanizeSkillSlug, skillFile } from "./tool-command";

type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme;
  path: string;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const parsed = parseUnifiedContextUri(uriOrPath);
  return parsed.ok ? parsed.value : { scheme: "manuscript", path: uriOrPath };
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

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? schemeLabel(scheme);
}
