/**
 * The `ls` result (D61): the typed listing the handler returns, and the plain
 * text the model reads of it. The app's tool row and code mode read the
 * fields; nothing parses the text back.
 */
import type { DocumentFileType } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";

export interface LsEntry {
  uri: string;
  kind: "file" | "directory";
  /** True when the agent can't edit the entry. */
  readonly: boolean;
  /** A non-text file's kind, so the model knows `read` returns no text. Text documents have none. */
  fileType?: DocumentFileType;
  /** With `verbose`: words in a text document. */
  wordCount?: number;
  /** With `verbose`: an upload's stored size. */
  sizeBytes?: number;
  /** With `verbose`: when the file was last edited (ISO 8601). */
  updatedAt?: string;
}

export interface LsResult {
  /** The listed folder's URI; null for the root listing, which lists each source. */
  uri: string | null;
  entries: LsEntry[];
}

export function isLsResult(value: unknown): value is LsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Partial<LsResult>;
  return (typeof result.uri === "string" || result.uri === null) && Array.isArray(result.entries);
}

const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Folders first, then files, each in natural name order (`chapter-2` before `chapter-10`). */
export function sortLsEntries<T extends Pick<LsEntry, "uri" | "kind">>(entries: readonly T[]): T[] {
  return [...entries].sort(
    (a, b) =>
      Number(a.kind !== "directory") - Number(b.kind !== "directory") ||
      NAME_ORDER.compare(a.uri, b.uri),
  );
}

/** The model's text for an `ls` result; the executor renders refusals (D65). */
export function renderLsResult(value: JsonValue): string {
  if (!isLsResult(value)) return JSON.stringify(value);
  if (value.uri === null) {
    return value.entries.length === 0
      ? "(empty)"
      : value.entries.map((entry) => entryLine(entry)).join("\n");
  }
  const folder = asFolder(value.uri);
  const lines = value.entries.map((entry) => `  ${entryLine(entry, folder)}`);
  return [folder, ...(lines.length > 0 ? lines : ["  (empty)"])].join("\n");
}

function entryLine(entry: LsEntry, folder?: string): string {
  const relative =
    folder && entry.uri.startsWith(folder) ? entry.uri.slice(folder.length) : entry.uri;
  const name = entry.kind === "directory" ? asFolder(relative) : relative;
  const notes = [
    entry.fileType,
    entry.wordCount === undefined ? undefined : words(entry.wordCount),
    entry.sizeBytes === undefined || entry.fileType === undefined
      ? undefined
      : formatBytes(entry.sizeBytes),
    entry.updatedAt === undefined ? undefined : `edited ${formatUtc(entry.updatedAt)}`,
    entry.readonly ? "read-only" : undefined,
  ].filter((note) => note !== undefined);
  return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
}

function asFolder(uri: string): string {
  return uri.endsWith("/") ? uri : `${uri}/`;
}

function words(count: number): string {
  return count === 1 ? "1 word" : `${count} words`;
}

// Same units as the project rail's file sizes.
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const utc = date.toISOString();
  return `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC`;
}
