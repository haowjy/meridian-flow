/** Strict selection validation and content-based resume identity. */
import { createHash } from "node:crypto";
import type { ImportManifest, ImportRefusalCode } from "@meridian/contracts";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { filetypeForKnownPath } from "@meridian/contracts/protocol";
import { z } from "zod";

export const IMPORT_LIMITS = {
  entries: 10_000,
  /** Entries plus every folder the plan synthesizes for their ancestors. */
  plannedNodes: 20_000,
  pathDepth: 64,
  pathBytes: 4096,
  manifestBytes: 32 * 1024 * 1024,
  /** Multipart framing allowance on top of the file bytes a request may carry. */
  multipartOverheadBytes: 1024 * 1024,
  partsPerRequest: 200,
  landingConcurrency: 4,
  receivesPerImport: 4,
  fileBytes: 50 * 1024 * 1024,
  totalBytes: 2 * 1024 ** 3,
  requestBytes: 8 * 1024 * 1024,
  chunkSize: 200,
  leaseMs: 120_000,
  /** How long after a lease a hung put may still land its object before cleanup retires. */
  latePutGraceMs: 60 * 60 * 1000,
  sweepBatch: 500,
} as const;
/** A coded refusal; diagnostics stay server-side, the writer-facing app maps the code. */
export class ImportError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ImportRefusalCode,
    public readonly params?: Record<string, number>,
  ) {
    super(code);
  }
}
function refuse(code: ImportRefusalCode, params?: Record<string, number>): never {
  throw new ImportError(400, code, params);
}
const name = z
  .string()
  .min(1)
  .refine(
    (value) => value === value.normalize("NFC") && validateContextEntryName(value).ok,
    "Invalid name",
  );
// Bounds run before segment validation so a deep path is never split and walked.
const boundedPath = (segmentOk: (segment: string) => boolean) =>
  z.string().superRefine((value, context) => {
    if (Buffer.byteLength(value) > IMPORT_LIMITS.pathBytes)
      context.addIssue({ code: "custom", params: { refusal: "path_too_long" }, fatal: true });
    else if (value.split("/", IMPORT_LIMITS.pathDepth + 1).length > IMPORT_LIMITS.pathDepth)
      context.addIssue({ code: "custom", params: { refusal: "path_too_deep" }, fatal: true });
    else if (value !== "" && !value.split("/").every(segmentOk))
      context.addIssue({ code: "custom", message: "Invalid relative path" });
  });
const path = boundedPath((segment) => name.safeParse(segment).success);
/**
 * An unreadable item is only reported, never named in the tree, so it keeps its
 * source name even when Meridian would refuse it (`Who?.md`). It must still be a
 * plain relative path: no empty, `.` or `..` segment and no control character.
 */
const sourcePath = boundedPath(
  (segment) =>
    segment.trim() !== "" &&
    segment !== "." &&
    segment !== ".." &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    !/[\u0000-\u001f]/.test(segment),
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
    roots: z.array(root).min(1).max(IMPORT_LIMITS.entries),
    folders: z
      .array(z.object({ rootId: z.number().int().nonnegative(), path }).strict())
      .max(IMPORT_LIMITS.entries),
    unreadable: z
      .array(
        z
          .object({
            rootId: z.number().int().nonnegative(),
            path: sourcePath,
            reason: z
              .enum([
                "unreadable",
                "permission_denied",
                "not_found",
                "symlink",
                "folder_unreadable",
              ])
              .optional(),
          })
          .strict(),
      )
      .max(IMPORT_LIMITS.entries)
      .optional(),
    entries: z
      .array(
        z
          .object({
            entryId: z.number().int().nonnegative(),
            rootId: z.number().int().nonnegative(),
            path,
            size: z.number().int().nonnegative().max(IMPORT_LIMITS.totalBytes),
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
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const refusal = issue.code === "custom" ? issue.params?.refusal : undefined;
      if (refusal === "path_too_long") refuse("path_too_long", { limit: IMPORT_LIMITS.pathBytes });
      if (refusal === "path_too_deep") refuse("path_too_deep", { limit: IMPORT_LIMITS.pathDepth });
    }
    refuse("manifest_invalid");
  }
  const value = parsed.data;
  if (value.entries.length + (value.unreadable?.length ?? 0) > IMPORT_LIMITS.entries)
    refuse("too_many_files", { limit: IMPORT_LIMITS.entries });
  const roots = new Map(value.roots.map((root) => [root.rootId, root]));
  if (roots.size !== value.roots.length) refuse("duplicate_root_id");
  if (new Set(value.entries.map((entry) => entry.entryId)).size !== value.entries.length)
    refuse("duplicate_entry_id");
  if (plannedNodeCount(value) > IMPORT_LIMITS.plannedNodes)
    refuse("too_many_nodes", { limit: IMPORT_LIMITS.plannedNodes });
  const locations = new Set<string>();
  for (const entry of [...value.entries, ...value.folders]) {
    const root = roots.get(entry.rootId);
    if (!root || (root.kind === "file" ? entry.path !== "" : entry.path === ""))
      refuse("invalid_root_path");
    const key = JSON.stringify([entry.rootId, entry.path]);
    if (locations.has(key)) refuse("duplicate_selection_path");
    locations.add(key);
  }
  for (const unreadable of value.unreadable ?? []) {
    const selectedRoot = roots.get(unreadable.rootId);
    if (!selectedRoot || (selectedRoot.kind === "file" && unreadable.path !== ""))
      refuse("invalid_root_path");
    const key = JSON.stringify([unreadable.rootId, unreadable.path]);
    if (locations.has(key)) refuse("duplicate_selection_path");
    locations.add(key);
    if (
      selectedRoot.kind === "folder" &&
      unreadable.path === "" &&
      [...value.entries, ...value.folders].some((entry) => entry.rootId === unreadable.rootId)
    )
      refuse("unreadable_root_has_entries");
  }
  for (const entry of value.entries) {
    const selectedRoot = roots.get(entry.rootId);
    const filename = selectedRoot?.kind === "file" ? selectedRoot.name : entry.path;
    const type = filetypeForKnownPath(filename);
    if (entry.size > 0 && (type === null || type === "markdown") && entry.sniff === undefined)
      refuse("sniff_required");
    if (
      entry.sniff !== undefined &&
      Buffer.from(entry.sniff, "base64").length !== Math.min(512, entry.size)
    )
      refuse("sniff_length");
  }
  for (const folder of value.folders)
    if (roots.get(folder.rootId)?.kind !== "folder") refuse("invalid_file_root");
  for (const root of value.roots) {
    if (
      root.kind === "file" &&
      (root.appJson !== undefined ||
        root.meridianExport !== undefined ||
        value.entries.filter((entry) => entry.rootId === root.rootId).length +
          (value.unreadable ?? []).filter((entry) => entry.rootId === root.rootId).length !==
          1)
    )
      refuse("invalid_file_root");
  }
  if (value.entries.reduce((sum, entry) => sum + entry.size, 0) > IMPORT_LIMITS.totalBytes)
    refuse("import_too_large", { limit: IMPORT_LIMITS.totalBytes });
  return value;
}
/** Roots, entries, unreadable paths and every distinct folder their paths imply. */
function plannedNodeCount(manifest: ImportManifest) {
  const folders = new Set<string>();
  for (const root of manifest.roots) if (root.kind === "folder") folders.add(`${root.rootId}:`);
  for (const item of [...manifest.folders, ...manifest.entries]) {
    const segments = item.path.split("/");
    const depth = "entryId" in item ? segments.length - 1 : segments.length;
    for (let index = 1; index <= depth; index++)
      folders.add(`${item.rootId}:${segments.slice(0, index).join("/")}`);
  }
  return folders.size + manifest.entries.length + (manifest.unreadable?.length ?? 0);
}
export function manifestFingerprint(manifest: ImportManifest): string {
  const roots = manifest.roots
    .map((root) =>
      JSON.stringify([
        root.kind,
        root.name,
        root.appJson ?? null,
        root.meridianExport ?? null,
        manifest.entries
          .filter((entry) => entry.rootId === root.rootId)
          .map((entry) =>
            JSON.stringify([entry.path, entry.size, entry.sha256, entry.frontmatter ?? null]),
          )
          .sort(),
        manifest.folders
          .filter((folder) => folder.rootId === root.rootId)
          .map((folder) => folder.path)
          .sort(),
        ...((manifest.unreadable?.length ?? 0)
          ? [
              (manifest.unreadable ?? [])
                .filter((entry) => entry.rootId === root.rootId)
                .map((entry) => JSON.stringify([entry.path, entry.reason ?? "unreadable"]))
                .sort(),
            ]
          : []),
      ]),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(roots)).digest("hex");
}
