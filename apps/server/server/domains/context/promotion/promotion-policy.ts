/**
 * Type-based auto-promotion policy for generated artifacts → `work://.results/`.
 * Single table — extend here when new pilot output types land.
 */

export type PromotionDecision = "promote" | "skip";
export interface PromotionPolicyMatch {
  decision: PromotionDecision;
  /** MIME persisted on the object store row when decision is promote. */
  mimeType?: string;
}

const EXTENSION_MIME: ReadonlyArray<{ suffix: string; mimeType: string }> = [
  { suffix: ".nii.gz", mimeType: "application/gzip" },
  { suffix: ".nii", mimeType: "application/octet-stream" },
  { suffix: ".png", mimeType: "image/png" },
  { suffix: ".jpg", mimeType: "image/jpeg" },
  { suffix: ".jpeg", mimeType: "image/jpeg" },
  { suffix: ".gif", mimeType: "image/gif" },
  { suffix: ".webp", mimeType: "image/webp" },
  { suffix: ".tif", mimeType: "image/tiff" },
  { suffix: ".tiff", mimeType: "image/tiff" },
  { suffix: ".pdf", mimeType: "application/pdf" },
  { suffix: ".zip", mimeType: "application/zip" },
  { suffix: ".json", mimeType: "application/json" },
];

/**
 * Ordered policy rows (first match wins). Suffix rules cover pilot binary outputs;
 * everything else is skipped so scratch logs and text intermediates stay ephemeral.
 */
export const PROMOTION_POLICY_TABLE: ReadonlyArray<{
  label: string;
  match: (sourcePath: string) => boolean;
  mimeType: string;
}> = [
  {
    label: "NIfTI volumes (.nii.gz, .nii)",
    match: (path) => path.endsWith(".nii.gz") || path.endsWith(".nii"),
    mimeType: "application/gzip",
  },
  {
    label: "Raster images (PNG/JPEG/GIF/WebP/TIFF) — includes QC renders",
    match: (path) => /\.(png|jpe?g|gif|webp|tiff?)$/i.test(path),
    mimeType: "image/png",
  },
  {
    label: "JSON metadata sidecars",
    match: (path) => path.endsWith(".json"),
    mimeType: "application/json",
  },
  {
    label: "PDF reports",
    match: (path) => path.endsWith(".pdf"),
    mimeType: "application/pdf",
  },
  {
    label: "ZIP archives",
    match: (path) => path.endsWith(".zip"),
    mimeType: "application/zip",
  },
];

function mimeForPath(sourcePath: string): string | undefined {
  const lower = sourcePath.toLowerCase();
  for (const entry of EXTENSION_MIME) {
    if (lower.endsWith(entry.suffix)) return entry.mimeType;
  }
  return undefined;
}

export function evaluatePromotionPolicy(sourcePath: string): PromotionPolicyMatch {
  const normalized = sourcePath.replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) return { decision: "skip" };

  for (const row of PROMOTION_POLICY_TABLE) {
    if (!row.match(normalized)) continue;
    return { decision: "promote", mimeType: mimeForPath(normalized) ?? row.mimeType };
  }

  return { decision: "skip" };
}
