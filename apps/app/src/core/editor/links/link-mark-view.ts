/**
 * Drawing what the resolver answered onto a link mark's `<a>`, without
 * storing any of it.
 *
 * The mark stores what a link names (its ref and href) and nothing about
 * whether it resolves (law 9), so the answer is drawn on the live element the
 * mark view owns: never in the schema, the wire format, or another peer's
 * document. The link mark renders outermost, so the `<a>` is one element
 * around the whole label, and a label with mixed formatting is one chip.
 *
 * Gone and missing both draw dashed. What tells a screen reader which, and
 * whether the link can be followed, rides the same `<a>`: `aria-description`,
 * and `aria-disabled` on a gone link, as chat's reference does.
 */

import { t } from "@lingui/core/macro";

import { linkChip, linkChipAttributes } from "./link-chip";
import { type LinkKey, linkKeyOfMark } from "./link-resolution";
import type { MountedLinks } from "./link-storage";
import { classifyLinkTarget, isInternalLinkTarget, linkTargetHref } from "./link-target";

/**
 * Keeps a link element's chip and accessible state in step with its answer,
 * and asks about the link while the element is shown. Returns the release.
 */
export function drawLinkAnswer(
  element: HTMLElement,
  link: { readonly [attribute: string]: unknown },
  links: MountedLinks | null,
): () => void {
  const stored = linkKeyOfMark(link);
  const target = classifyLinkTarget(stored.href);
  if (!links || !target || !isInternalLinkTarget(target)) return () => {};
  const { resolution, requester } = links;
  const key: LinkKey = { ref: stored.ref, href: linkTargetHref(target) };

  const sync = () => {
    const entry = resolution.read(key);
    // An editor with no project behind it draws its links as plain anchors.
    const chip = resolution.available ? linkChip(target, entry, resolution.baseUri) : null;
    const attributes = chip ? linkChipAttributes(chip) : null;
    draw(element, "data-link-chip", attributes?.["data-link-chip"] ?? null);
    draw(element, "data-link-chip-icon", attributes?.["data-link-chip-icon"] ?? null);
    draw(
      element,
      "aria-description",
      entry?.state === "gone"
        ? t`No longer available`
        : entry?.state === "missing"
          ? t`Doesn't exist yet`
          : null,
    );
    // Nothing follows a gone link, so it also loses the pointer and the hover.
    draw(element, "aria-disabled", entry?.state === "gone" ? "true" : null);
  };

  sync();
  const unsubscribe = resolution.subscribe(sync);
  const release = requester.watch(key);
  return () => {
    release();
    unsubscribe();
  };
}

// Every publish reaches every link on the page; only a changed value touches the DOM.
function draw(element: HTMLElement, name: string, value: string | null): void {
  if (element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
