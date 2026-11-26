import { t } from "@lingui/core/macro";
import { parseLinkRef } from "@meridian/contracts";

import { uploads } from "@/core/uploads/upload-store";

import { chipLinkTarget, linkChip, linkChipAttributes, linkChipDetail } from "./link-chip";
import { goneLinkDocumentId, type LinkKey, linkKeyOfMark } from "./link-resolution";
import type { MountedLinks } from "./link-storage";
import { linkTargetHref } from "./link-target";

export function drawLinkAnswer(
  element: HTMLElement,
  link: { readonly [attribute: string]: unknown },
  links: MountedLinks | null,
): () => void {
  const stored = linkKeyOfMark(link);
  const target = chipLinkTarget(stored.href);
  if (!links || !target) return () => {};
  const { resolution, requester } = links;
  const key: LinkKey = { ref: stored.ref, href: linkTargetHref(target) };
  const ref = parseLinkRef(stored.ref);
  const uploadOf = ref?.kind === "doc" ? ref.documentId : null;

  const sync = () => {
    const upload = uploadOf === null ? null : uploads.of(uploadOf);
    const entry = resolution.read(key);
    draw(element, "data-link-detail", linkChipDetail(entry, upload));
    draw(element, "data-link-upload", upload?.kind ?? null);
    element.style.setProperty(
      "--link-upload-progress",
      upload?.kind === "uploading" && upload.percent !== null ? `${upload.percent}%` : "0%",
    );
    const chip = resolution.available ? linkChip(target, entry, resolution.baseUri) : null;
    const attributes = chip ? linkChipAttributes(chip) : null;
    const folder =
      parseLinkRef(stored.ref)?.kind === "folder" ||
      target.addressKind === "folder" ||
      entry?.state === "folder";
    draw(element, "data-link-chip", attributes?.["data-link-chip"] ?? null);
    draw(element, "data-link-chip-icon", attributes?.["data-link-chip-icon"] ?? null);
    draw(element, "role", folder ? "button" : "link");
    draw(element, "aria-haspopup", folder ? "menu" : null);
    const inDraft = entry?.state === "document" && entry.draft ? t`In a draft` : null;
    draw(
      element,
      "aria-description",
      upload?.kind === "failed"
        ? upload.message || t`Upload failed`
        : entry?.state === "gone"
          ? t`No longer available`
          : entry?.state === "missing"
            ? t`Doesn't exist yet`
            : inDraft,
    );
    draw(element, "title", inDraft ?? (typeof link.title === "string" ? link.title : null));
    draw(
      element,
      "aria-disabled",
      entry?.state === "gone" && !goneLinkDocumentId(entry, key) ? "true" : null,
    );
  };

  sync();
  const unsubscribe = resolution.subscribe((uploadsChanged) => {
    if (uploadsChanged && (uploadOf === null || !uploadsChanged.has(uploadOf))) return;
    sync();
  });
  const release = requester.watch(key);
  return () => {
    release();
    unsubscribe();
  };
}

function draw(element: HTMLElement, name: string, value: string | null): void {
  if (element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
