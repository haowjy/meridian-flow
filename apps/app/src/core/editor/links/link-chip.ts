import { t } from "@lingui/core/macro";
import {
  addressScheme,
  CONTEXT_URI_SCHEMES,
  type ContextUriScheme,
} from "@meridian/contracts/context-uri";
import type { UploadState } from "@/core/uploads/upload-store";
import { fileTypeLabel } from "@/lib/file-type-label";
import { formatBytes } from "@/lib/format-size";

import type { LinkResolutionEntry } from "./link-resolution";
import {
  classifyLinkTarget,
  type InternalLinkTarget,
  isInternalLinkTarget,
  type LinkTarget,
} from "./link-target";

export type LinkChipIcon = ContextUriScheme | "file" | "folder";

export type LinkChip = { state: "filled" | "dashed" | "draft"; icon: LinkChipIcon };

export function chipLinkTarget(href: unknown): InternalLinkTarget | null {
  const target = typeof href === "string" ? classifyLinkTarget(href) : null;
  return target && isInternalLinkTarget(target) ? target : null;
}

export const LINK_CHIP_ICONS: readonly LinkChipIcon[] = [...CONTEXT_URI_SCHEMES, "file", "folder"];

export function linkChip(
  target: LinkTarget,
  entry: LinkResolutionEntry | null,
  baseUri: string | null = null,
): LinkChip | null {
  if (target.kind === "external") return null;
  if (entry?.state === "document")
    return { state: entry.draft ? "draft" : "filled", icon: entry.document.scheme };
  if (entry?.state === "folder") return { state: "filled", icon: "folder" };
  if (target.addressKind === "folder")
    return {
      state: entry?.state === "gone" ? "dashed" : "filled",
      icon: "folder",
    };
  const icon = targetFamily(target, baseUri) ?? "file";
  const reachesNothing = entry?.state === "missing" || entry?.state === "gone";
  return { state: reachesNothing ? "dashed" : "filled", icon };
}

export function referenceChip(
  reference: { kind: "document" | "folder"; uri: string },
  available = true,
): LinkChip {
  return {
    state: available ? "filled" : "dashed",
    icon: reference.kind === "folder" ? "folder" : (addressScheme(reference.uri) ?? "file"),
  };
}

export function linkChipAttributes(chip: LinkChip): {
  "data-link-chip": LinkChip["state"];
  "data-link-chip-icon": LinkChipIcon;
} {
  return { "data-link-chip": chip.state, "data-link-chip-icon": chip.icon };
}

function targetFamily(target: LinkTarget, baseUri: string | null): ContextUriScheme | null {
  if (target.kind === "scheme") return addressScheme(target.uri);
  return baseUri ? addressScheme(baseUri) : null;
}

function fileFacts(name: string, mimeType: string, sizeBytes: number | null): string | null {
  const facts = [fileTypeLabel(name, mimeType), sizeBytes === null ? "" : formatBytes(sizeBytes)];
  const known = facts.filter(Boolean);
  return known.length > 0 ? known.join(", ") : null;
}

export function linkChipDetail(
  entry: LinkResolutionEntry | null,
  upload: UploadState | null,
): string | null {
  if (upload?.kind === "failed") return t`Upload failed. Click to retry`;
  if (upload?.kind === "uploading")
    return upload.percent === null ? t`Uploading` : t`Uploading ${upload.percent}%`;
  if (entry?.state !== "document") return null;
  const { file, title } = entry.document;
  if (!file || file.fileType === "image") return null;
  return fileFacts(title, file.mimeType ?? "", file.sizeBytes);
}
