/**
 * Shared naming logic for inline context-entry create rows.
 *
 * Both create surfaces — the desktop tree panel's CreateRow and the phone
 * Files browser's MobileCreateRow — turn a typed leaf name plus the current
 * parent folder into the `path` for the create mutation. Keeping the join and
 * validation here means the two rows cannot drift on what counts as a legal
 * name (single source of truth; the server still enforces its own checks).
 *
 * Deliberate scope: no extension handling. A file is created exactly as
 * typed (`notes` stays `notes`, `notes.md` stays `notes.md`) — this matches
 * the desktop flow, where the server's filename parsing owns extension
 * semantics.
 */
import { t } from "@lingui/core/macro";

/**
 * Joins a parent folder path (`""` or `/a/b` — scheme root is the empty
 * string) with a leaf name into the absolute scheme-relative path the create
 * endpoint expects (`/leaf`, `/a/b/leaf`).
 */
export function joinContextEntryPath(parent: string, leaf: string): string {
  const prefix = parent && parent !== "/" ? parent.replace(/\/+$/, "") : "";
  return `${prefix}/${leaf}`;
}

/**
 * Localized validation error for a proposed (already-trimmed) entry name, or
 * null when the name is acceptable. An empty name is not an error — both
 * create rows treat committing an empty input as cancel, so only callers
 * with a non-empty name ask for a reason.
 */
export function invalidContextEntryNameReason(name: string): string | null {
  if (/[/]/.test(name)) return t`Names cannot contain '/'`;
  return null;
}
