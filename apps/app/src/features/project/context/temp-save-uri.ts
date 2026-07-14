/**
 * temp-save-uri — pure parse/format between the save bar's single URI field
 * (`manuscript://folder/name`) and the save hook's `{destination, name}` pair.
 *
 * The field speaks the app's context-URI grammar, restricted to the durable
 * schemes a temp document may save into. Parsing is structural only — deeper
 * name validation (illegal characters, reserved names) stays in the save flow.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import type { Destination } from "./use-temp-document-save";

/** Schemes a temp document can be durably saved into. */
export const DURABLE_SAVE_SCHEMES = ["manuscript", "kb", "user"] as const;

const DURABLE_SET = new Set<string>(DURABLE_SAVE_SCHEMES);
const URI_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

export type ParsedSaveUri = { destination: Destination; name: string };

export function formatSaveUri(destination: Destination, name: string): string {
  const segments = destination.path.split("/").filter(Boolean);
  return `${destination.scheme}://${[...segments, name].join("/")}`;
}

/**
 * Structural parse of the field text. Returns null while the text is not a
 * saveable URI (missing scheme, non-durable scheme, empty name) — callers
 * treat null as "keep the last valid state and disable Save".
 */
export function parseSaveUri(text: string): ParsedSaveUri | null {
  const match = URI_PATTERN.exec(text.trim());
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  if (!DURABLE_SET.has(scheme)) return null;
  const segments = (match[2] ?? "").split("/");
  const name = (segments.pop() ?? "").trim();
  if (!name) return null;
  const folders = segments.map((segment) => segment.trim()).filter(Boolean);
  return {
    destination: {
      scheme: scheme as ProjectContextTreeScheme,
      path: `/${folders.join("/")}`,
    },
    name,
  };
}

/**
 * The in-progress last path token — what the writer is typing right now —
 * which drives the folder-suggestion filter. `manuscript://ge` → `ge`;
 * a trailing slash (or bare scheme) browses everything.
 */
export function saveUriSuggestionQuery(text: string): string {
  const match = URI_PATTERN.exec(text.trim());
  const remainder = match ? (match[2] ?? "") : text.trim();
  return remainder.split("/").pop() ?? "";
}
