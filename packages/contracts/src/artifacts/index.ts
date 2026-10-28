/** Artifact references carried by saved agent reports and invocation cards. */
import { z } from "zod";

export const artifactRefSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    url: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("object"),
    uri: z.string(),
    label: z.string().optional(),
    mimeType: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("liveView"),
    url: z.string(),
    expiresAt: z.string().optional(),
  }),
]);

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export function isArtifactRef(value: unknown): value is ArtifactRef {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.url === "string") {
    return (
      (record.mimeType === undefined || typeof record.mimeType === "string") &&
      (record.label === undefined || typeof record.label === "string")
    );
  }
  if (record.type === "object" && typeof record.uri === "string") {
    return (
      (record.label === undefined || typeof record.label === "string") &&
      (record.mimeType === undefined || typeof record.mimeType === "string")
    );
  }
  return (
    record.type === "liveView" &&
    typeof record.url === "string" &&
    (record.expiresAt === undefined || typeof record.expiresAt === "string")
  );
}
