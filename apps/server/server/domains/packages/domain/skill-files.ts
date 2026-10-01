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
  return Buffer.from(entry.data, "base64");
}

export async function readSkillFileFromDisk(filePath: string): Promise<SkillFileEntry> {
  return bufferToSkillFileEntry(await readFile(filePath));
}

export async function writeSkillFileToDisk(filePath: string, entry: SkillFileEntry): Promise<void> {
  await writeFile(filePath, skillFileEntryToBuffer(entry));
}

export function normalizeSkillFilesForChecksum(files: SkillFiles): SkillFiles {
  return Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => left.localeCompare(right)),
  );
}
