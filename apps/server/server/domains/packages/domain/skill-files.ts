// @ts-nocheck
/**
 * Skill file payload encoding for JSON-natural persistence.
 *
 * UTF-8 text files stay plain strings (backward compatible with early imports).
 * Non-UTF-8 payloads are base64-armed as `{ encoding: "base64", data }` so
 * SkillRecord.files round-trips through JSONB without corruption.
 */
import { readFile, writeFile } from "node:fs/promises";

export type SkillFileEntry =
  | string
  | {
      encoding: "base64";
      data: string;
    };

export type SkillFiles = Record<string, SkillFileEntry>;

export function bufferToSkillFileEntry(buffer: Buffer): SkillFileEntry {
  const text = buffer.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buffer)) {
    return text;
  }
  return { encoding: "base64", data: buffer.toString("base64") };
}

export function skillFileEntryToBuffer(entry: SkillFileEntry): Buffer {
  if (typeof entry === "string") {
    return Buffer.from(entry, "utf8");
  }
  if (entry.encoding === "base64") {
    return Buffer.from(entry.data, "base64");
  }
  throw new Error(
    `Unsupported skill file encoding: ${String((entry as { encoding?: string }).encoding)}`,
  );
}

export async function readSkillFileFromDisk(filePath: string): Promise<SkillFileEntry> {
  return bufferToSkillFileEntry(await readFile(filePath));
}

export async function writeSkillFileToDisk(filePath: string, entry: SkillFileEntry): Promise<void> {
  await writeFile(filePath, skillFileEntryToBuffer(entry));
}

export function skillFilesFromJson(value: unknown): SkillFiles {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const files: SkillFiles = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      files[key] = entry;
      continue;
    }
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { encoding?: string }).encoding === "base64" &&
      typeof (entry as { data?: unknown }).data === "string"
    ) {
      files[key] = { encoding: "base64", data: (entry as { data: string }).data };
    }
  }
  return files;
}

export function normalizeSkillFilesForChecksum(files: SkillFiles): SkillFiles {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}
