/**
 * temp-save-uri — pure parse/format between the save bar's single URI field
 * (`manuscript://folder/name`) and the save hook's `{destination, name}` pair.
 *
 * The grammar itself is owned by `lib/context-uri.ts` (`splitContextUri`);
 * this module interprets the remainder for saving: last segment = name, rest
 * = folder, restricted to the durable schemes a temp document may save into.
 * Parsing is structural only — deeper name validation (illegal characters,
 * reserved names) stays in the save flow.
 */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";

import { splitContextUri } from "@/lib/context-uri";

import type { Destination } from "./use-temp-document-save";

/** Schemes a temp document can be durably saved into. */
export const DURABLE_SAVE_SCHEMES = ["manuscript", "kb", "user"] as const;

const DURABLE_SET = new Set<string>(DURABLE_SAVE_SCHEMES);

export type ParsedSaveUri = { destination: Destination; name: string };

/** A structurally valid location whose name may still be empty (`…/gel/`). */
export type SaveLocation = { folder: Destination; name: string };

export function formatSaveUri(destination: Destination, name: string): string {
  const segments = destination.path.split("/").filter(Boolean);
  return `${destination.scheme}://${[...segments, name].join("/")}`;
}

/**
 * Structural parse of the field's location: scheme + folder, with whatever
 * (possibly empty) name segment follows. A trailing slash is a legal
 * location — the browser can descend into `…://gel/` before a name exists —
 * it just isn't saveable yet.
 */
export function parseSaveLocation(text: string): SaveLocation | null {
  const cracked = splitContextUri(text.trim());
  if (!cracked) return null;
  const scheme = cracked.scheme.toLowerCase();
  if (!DURABLE_SET.has(scheme)) return null;
  const segments = cracked.remainder.split("/");
  const name = (segments.pop() ?? "").trim();
  const folders = segments.map((segment) => segment.trim()).filter(Boolean);
  return {
    folder: {
      scheme: scheme as ProjectContextTreeScheme,
      path: `/${folders.join("/")}`,
    },
    name,
  };
}

/**
 * A *saveable* parse: a valid location with a non-empty name. Callers treat
 * null as "keep the last valid state and disable Save". Derivable from
 * `parseSaveLocation` — callers that already hold a location should derive
 * instead of parsing twice.
 */
export function parseSaveUri(text: string): ParsedSaveUri | null {
  return saveTargetFromLocation(parseSaveLocation(text));
}

/** The saveable target a location denotes, or null while the name is empty. */
export function saveTargetFromLocation(location: SaveLocation | null): ParsedSaveUri | null {
  if (!location?.name) return null;
  return { destination: location.folder, name: location.name };
}

/**
 * The in-progress last path token — what the writer is typing right now —
 * which drives the folder-suggestion filter. `manuscript://ge` → `ge`;
 * a trailing slash (or bare scheme) browses everything.
 */
export function saveUriSuggestionQuery(text: string): string {
  const cracked = splitContextUri(text.trim());
  const remainder = cracked ? cracked.remainder : text.trim();
  return remainder.split("/").pop() ?? "";
}
