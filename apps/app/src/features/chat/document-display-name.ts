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

type ParsedContextLocation = {
  scheme: ProjectContextTreeScheme;
  path: string;
};

function parseContextLocation(uriOrPath: string): ParsedContextLocation {
  const parsed = parseUnifiedContextUri(uriOrPath);
  return parsed.ok ? parsed.value : { scheme: "manuscript", path: uriOrPath };
}

export function isContextUri(value: string): boolean {
  const parsed = parseUnifiedContextUri(value);
  return parsed.ok && value.trim().startsWith(`${parsed.value.scheme}://`);
}

/**
 * The document's name, and nothing else. Where it lives is not part of what a
 * timeline row claims: the row says what the agent did to a document, and the
 * name's door already goes wherever that document is. The one place location
 * still earns its keep is the dead-route pane, which exists to say a document
 * is missing from a particular section.
 */
export function documentDisplayName(uriOrPath: string): string {
  const { path } = parseContextLocation(uriOrPath);
  return documentTitleFromUri(path) ?? t`Untitled document`;
}

export function folderDisplayName(uriOrPath: string): string {
  const { scheme, path } = parseContextLocation(uriOrPath);
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) ?? schemeLabel(scheme);
}
