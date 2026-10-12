/** Strict selection validation and content-based resume identity. */
import { createHash } from "node:crypto";
import type { ImportManifest } from "@meridian/contracts";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { z } from "zod";

export const IMPORT_LIMITS = {
  entries: 10_000,
  fileBytes: 50 * 1024 * 1024,
  totalBytes: 2 * 1024 ** 3,
  requestBytes: 8 * 1024 * 1024,
  chunkSize: 200,
  leaseMs: 120_000,
} as const;
export class ImportError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const name = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.normalize("NFC") && validateContextEntryName(value).ok,
    "Invalid name",
  );
const path = z
  .string()
  .refine(
    (value) => value === "" || value.split("/").every((segment) => name.safeParse(segment).success),
    "Invalid relative path",
  );
const root = z
  .object({
    rootId: z.number().int().nonnegative(),
    kind: z.enum(["folder", "file"]),
    name,
    appJson: z
      .string()
      .max(1024 * 1024)
      .optional(),
    meridianExport: z
      .string()
      .max(1024 * 1024)
      .optional(),
  })
  .strict();
const schema = z
  .object({
    importId: z.uuid(),
    destination: z
      .object({ folderUri: z.string().regex(/^(kb|manuscript|unfiled):\/\//) })
      .strict(),
    sort: z.boolean(),
    roots: z.array(root).min(1).max(IMPORT_LIMITS.entries),
    folders: z
      .array(z.object({ rootId: z.number().int().nonnegative(), path }).strict())
      .max(IMPORT_LIMITS.entries),
    entries: z
      .array(
        z
          .object({
            entryId: z.number().int().nonnegative(),
            rootId: z.number().int().nonnegative(),
            path,
            size: z.number().int().nonnegative().max(IMPORT_LIMITS.fileBytes),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            sniff: z
              .string()
              .max(684)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/)
              .optional(),
            frontmatter: z.string().max(IMPORT_LIMITS.fileBytes).optional(),
          })
          .strict(),
      )
      .max(IMPORT_LIMITS.entries),
  })
  .strict();
export function validateManifest(raw: unknown): ImportManifest {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ImportError(400, parsed.error.message);
  const value = parsed.data;
  const roots = new Map(value.roots.map((root) => [root.rootId, root]));
  if (roots.size !== value.roots.length) throw new ImportError(400, "Duplicate rootId");
  if (new Set(value.entries.map((entry) => entry.entryId)).size !== value.entries.length)
    throw new ImportError(400, "Duplicate entryId");
  const locations = new Set<string>();
  for (const entry of [...value.entries, ...value.folders]) {
    const root = roots.get(entry.rootId);
    if (!root || (root.kind === "file" ? entry.path !== "" : entry.path === ""))
      throw new ImportError(400, "Invalid root path");
    const key = JSON.stringify([entry.rootId, entry.path]);
    if (locations.has(key)) throw new ImportError(400, "Duplicate selection path");
    locations.add(key);
  }
  for (const folder of value.folders)
    if (roots.get(folder.rootId)?.kind !== "folder")
      throw new ImportError(400, "File roots cannot contain folders");
  for (const root of value.roots) {
    if (
      root.kind === "file" &&
      (root.appJson !== undefined ||
        root.meridianExport !== undefined ||
        value.entries.filter((entry) => entry.rootId === root.rootId).length !== 1)
    )
      throw new ImportError(400, "Invalid file root");
  }
  if (value.entries.reduce((sum, entry) => sum + entry.size, 0) > IMPORT_LIMITS.totalBytes)
    throw new ImportError(400, "Import exceeds total size limit");
  return value;
}
export function manifestFingerprint(manifest: ImportManifest): string {
  const roots = manifest.roots
    .map((root) =>
      JSON.stringify([
        root.kind,
        root.name,
        manifest.entries
          .filter((entry) => entry.rootId === root.rootId)
          .map((entry) => JSON.stringify([entry.path, entry.size, entry.sha256]))
          .sort(),
        manifest.folders
          .filter((folder) => folder.rootId === root.rootId)
          .map((folder) => folder.path)
          .sort(),
      ]),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(roots)).digest("hex");
}
