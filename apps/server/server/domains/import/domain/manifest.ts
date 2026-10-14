/** Strict selection validation and the exact-command identity POST replay checks. */
import { createHash } from "node:crypto";
import {
  IMPORT_ADMISSION,
  type ImportRefusalCode,
  type ImportSelection,
  overFileBudget,
} from "@meridian/contracts";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import { z } from "zod";

export const IMPORT_LIMITS = {
  /** Entries plus every folder the plan synthesizes for their ancestors. */
  plannedNodes: 20_000,
  pathDepth: 64,
  pathBytes: 4096,
  manifestBytes: 32 * 1024 * 1024,
  /** Multipart framing allowance on top of the file bytes a request may carry. */
  multipartOverheadBytes: 1024 * 1024,
  receivesPerImport: 4,
  openPerUser: 3,
  receiptAgeMs: 60 * 60 * 1000,
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
    appJson: z.string().max(IMPORT_ADMISSION.sideFileBytes).optional(),
    meridianExport: z.string().max(IMPORT_ADMISSION.sideFileBytes).optional(),
  })
  .strict();
const schema = z
  .object({
    importId: z.uuid(),
    destination: z
      .object({ folderUri: z.string().regex(/^(kb|manuscript|unfiled):\/\//) })
      .strict(),
    roots: z.array(root).min(1).max(IMPORT_ADMISSION.files),
    folders: z
      .array(z.object({ rootId: z.number().int().nonnegative(), path }).strict())
      .max(IMPORT_ADMISSION.files),
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
      .max(IMPORT_ADMISSION.files)
      .optional(),
    entries: z
      .array(
        z
          .object({
            entryId: z.number().int().nonnegative(),
            rootId: z.number().int().nonnegative(),
            path,
            size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            modifiedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(IMPORT_ADMISSION.files),
  })
  .strict();
export function validateSelection(raw: unknown): ImportSelection {
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
  if (overFileBudget(value.entries.length, value.unreadable?.length ?? 0))
    refuse("too_many_files", { limit: IMPORT_ADMISSION.files });
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
  if (
    value.entries.reduce(
      (sum, entry) => sum + (entry.size <= IMPORT_ADMISSION.fileBytes ? entry.size : 0),
      0,
    ) > IMPORT_ADMISSION.totalBytes
  )
    refuse("import_too_large", { limit: IMPORT_ADMISSION.totalBytes });
  return value;
}
/** Roots, entries, unreadable paths and every distinct folder their paths imply. */
function plannedNodeCount(manifest: ImportSelection) {
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
/**
 * Identity of the exact create command: the validated manifest with object keys sorted, so
 * the same POST replays and any other command under that import id (a different destination,
 * root or entry id, file or order) is a mismatch.
 */
export function selectionFingerprint(manifest: ImportSelection): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex");
}
