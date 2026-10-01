/**
 * Readable transcript references, drawn as link chips; exact identity enables
 * navigation, never syntax alone.
 *
 * An exact `@` reference knows its document: its chip's family is its URI's,
 * and it is dashed once the document is gone. A syntax link (a wikilink, a
 * scheme URI) learns its state from the surface's own resolution cache, the
 * one its follows go through, so what it draws and what a click finds agree.
 */
import { t } from "@lingui/core/macro";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import {
  classifyLinkTarget,
  type LinkResolution,
  type LinkResolutionEntry,
  type LinkTarget,
  linkChip,
  linkChipAttributes,
  linkTargetHref,
  referenceChip,
} from "@/core/editor/links";

/**
 * How the hosting surface follows a link written as syntax (a wikilink, a
 * scheme URI, a relative path) rather than an exact submitted reference.
 * `canFollow` depends only on the target and the surface's base URI, never on
 * loading, so a reference does not flicker between a link and text.
 */
export type TranscriptLinkNavigation = {
  follow(target: LinkTarget): void;
  canFollow(target: LinkTarget): boolean;
  /** The cache the surface's follows resolve through; what a syntax link draws. */
  resolution: LinkResolution | null;
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
  const syntax = !documentId && target ? target : null;
  const syntaxFollowable = Boolean(syntax && navigation?.canFollow(syntax));
  const follow = documentId
    ? resolution?.available && onOpen
      ? () => onOpen(resolution.documentId)
      : undefined
    : navigation && syntax && syntaxFollowable
      ? () => navigation.follow(syntax)
      : undefined;
  const label = authoredLabel === "true" ? children : (resolution?.label ?? children);
  const unfollowable = Boolean(navigation && syntax && !syntaxFollowable);
  const answer = useLinkAnswer(
    syntax && !unfollowable ? (navigation?.resolution ?? null) : null,
    syntax ? linkTargetHref(syntax) : null,
  );
  // A syntax link this surface can never follow (a relative path with nothing
  // to be relative to) is text. A link control that can never work is a dead
  // control; the href stays reachable as a tooltip.
  if (unfollowable) return <span title={targetHref}>{label}</span>;
  const chip = documentId
    ? referenceChip(uri ?? "", resolution?.available ?? true)
    : syntax && linkChip(syntax, answer);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: Internal references have no browser URL; unavailable links still expose keyboard context actions. */}
        <span
          ref={trigger}
          role="link"
          tabIndex={0}
          aria-disabled={!follow}
          {...(chip ? linkChipAttributes(chip) : {})}
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

/**
 * What the cache says about one href, asked for while the reference is shown,
 * the way the Editor's decoration plugin asks for the links it draws. Asking
 * again on every publish is how a new generation (a scope or catalog change)
 * gets its question; an href already answered, or failed, is never re-asked,
 * so the loop ends. The cache batches, so many chips cost one question per
 * distinct target.
 */
function useLinkAnswer(
  resolution: LinkResolution | null,
  href: string | null,
): LinkResolutionEntry | null {
  const subscribe = useCallback(
    (listener: () => void) => resolution?.subscribe(listener) ?? (() => {}),
    [resolution],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (resolution && href ? resolution.read(href) : null),
    () => null,
  );
  useEffect(() => {
    if (!resolution || !href) return;
    let live = true;
    let scheduled = false;
    // Deferred and coalesced: asking publishes, and publishing from inside a
    // publish would re-enter every listener once per chip.
    const ask = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (live) resolution.request([href]);
      });
    };
    resolution.request([href]);
    const unsubscribe = resolution.subscribe(ask);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [resolution, href]);
  return entry;
}
