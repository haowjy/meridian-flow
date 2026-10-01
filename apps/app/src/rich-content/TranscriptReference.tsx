/** Readable transcript references; exact identity enables navigation, never syntax alone. */
import { t } from "@lingui/core/macro";
import { createContext, type ReactNode, useContext, useRef } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { classifyLinkTarget, type LinkTarget } from "@/core/editor/links";

/**
 * How the hosting surface follows a link written as syntax (a wikilink, a
 * scheme URI, a relative path) rather than an exact submitted reference.
 * `canFollow` depends only on the target and the surface's base URI, never on
 * loading, so a reference does not flicker between a link and text.
 */
export type TranscriptLinkNavigation = {
  follow(target: LinkTarget): void;
  canFollow(target: LinkTarget): boolean;
};

export const TranscriptLinkNavigationContext = createContext<TranscriptLinkNavigation | undefined>(
  undefined,
);

export type TranscriptReferenceResolution = {
  documentId: string;
  uri: string;
  label: string;
  available: boolean;
};
export const TranscriptReferenceContext = createContext<{
  resolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpen?: (documentId: string) => void;
}>({});

export function TranscriptReference({
  children,
  "data-document-id": documentId,
  "data-uri": uri,
  "data-target-href": targetHref,
  "data-authored-label": authoredLabel,
}: {
  children?: ReactNode;
  "data-document-id"?: string;
  "data-uri"?: string;
  "data-target-href"?: string;
  "data-authored-label"?: string;
}) {
  const { resolutions, onOpen } = useContext(TranscriptReferenceContext);
  const navigation = useContext(TranscriptLinkNavigationContext);
  const target = targetHref ? classifyLinkTarget(targetHref) : null;
  const trigger = useRef<HTMLSpanElement>(null);
  const candidate = documentId ? resolutions?.get(documentId) : null;
  const resolution =
    candidate?.documentId === documentId && candidate?.uri === uri ? candidate : null;
  const follow = documentId
    ? resolution?.available && onOpen
      ? () => onOpen(resolution.documentId)
      : undefined
    : navigation && target && navigation.canFollow(target)
      ? () => navigation.follow(target)
      : undefined;
  const label = authoredLabel === "true" ? children : (resolution?.label ?? children);
  // A syntax link this surface can never follow (a relative path with nothing
  // to be relative to) is text. A link control that can never work is a dead
  // control; the href stays reachable as a tooltip.
  if (!documentId && navigation && target && !navigation.canFollow(target)) {
    return <span title={targetHref}>{label}</span>;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: Internal references have no browser URL; unavailable links still expose keyboard context actions. */}
        <span
          ref={trigger}
          role="link"
          tabIndex={0}
          aria-disabled={!follow}
          className={follow ? "underline decoration-border-subtle underline-offset-2" : undefined}
          onClick={follow}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              follow?.();
            }
          }}
        >
          {label}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          trigger.current?.focus();
        }}
      >
        <ContextMenuLabel>{label}</ContextMenuLabel>
        {uri || targetHref ? (
          <ContextMenuLabel className="max-w-80 break-all font-normal text-muted-foreground">
            {uri ?? targetHref}
          </ContextMenuLabel>
        ) : null}
        {follow ? <ContextMenuItem onSelect={follow}>{t`Open link`}</ContextMenuItem> : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
