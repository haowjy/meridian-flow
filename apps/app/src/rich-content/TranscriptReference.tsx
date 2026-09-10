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

export const TranscriptLinkNavigationContext = createContext<
  ((target: LinkTarget) => void) | undefined
>(undefined);

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
  const navigateSyntax = useContext(TranscriptLinkNavigationContext);
  const target = targetHref ? classifyLinkTarget(targetHref) : null;
  const trigger = useRef<HTMLSpanElement>(null);
  const candidate = documentId ? resolutions?.get(documentId) : null;
  const resolution =
    candidate?.documentId === documentId && candidate?.uri === uri ? candidate : null;
  const follow = documentId
    ? resolution?.available && onOpen
      ? () => onOpen(resolution.documentId)
      : undefined
    : navigateSyntax && target && (target.kind === "wikilink" || target.kind === "scheme")
      ? () => navigateSyntax(target)
      : undefined;
  const label = authoredLabel === "true" ? children : (resolution?.label ?? children);
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
