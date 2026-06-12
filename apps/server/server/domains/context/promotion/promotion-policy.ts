export type PromotionDecision = "promote" | "skip";
export interface PromotionPolicyMatch {
  decision: PromotionDecision;
  mimeType?: string;
}
const EXTENSION_MIME: ReadonlyArray<{ suffix: string; mimeType: string }> = [
  { suffix: ".png", mimeType: "image/png" },
  { suffix: ".jpg", mimeType: "image/jpeg" },
  { suffix: ".jpeg", mimeType: "image/jpeg" },
  { suffix: ".gif", mimeType: "image/gif" },
  { suffix: ".webp", mimeType: "image/webp" },
  { suffix: ".pdf", mimeType: "application/pdf" },
  { suffix: ".zip", mimeType: "application/zip" },
  { suffix: ".json", mimeType: "application/json" },
];
export function evaluatePromotionPolicy(sourcePath: string): PromotionPolicyMatch {
  const normalized = sourcePath.replace(/^\/+/, "").toLowerCase();
  if (!normalized || normalized.includes("..")) return { decision: "skip" };
  const match = EXTENSION_MIME.find((entry) => normalized.endsWith(entry.suffix));
  return match ? { decision: "promote", mimeType: match.mimeType } : { decision: "skip" };
}
