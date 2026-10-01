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
  type LinkRequester,
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
  /** Ask about an href while it is shown; one batched requester per surface. */
  watch: LinkRequester["watch"];
};

export const TranscriptLinkNavigationContext = createContext<TranscriptLinkNavigation | undefined>(
  undefined,
);

/**
 * What the host knows about an exact reference's document. Available carries
 * where it lives now; a gone document has nowhere, so it matches on identity
 * alone and draws dashed.
 */
export type TranscriptReferenceResolution =
  | { documentId: string; available: true; uri: string; label: string }
  | { documentId: string; available: false };
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
  // An available answer counts only at the URI the writer referenced: a
  // document that has moved since is not settled for this occurrence, so it
  // stays filled and does not follow from here.
  const resolution =
    candidate &&
    candidate.documentId === documentId &&
    (!candidate.available || candidate.uri === uri)
      ? candidate
      : null;
  const syntax = !documentId && target ? target : null;
  const syntaxFollowable = Boolean(syntax && navigation?.canFollow(syntax));
  const follow = documentId
    ? resolution?.available && onOpen
      ? () => onOpen(resolution.documentId)
      : undefined
    : navigation && syntax && syntaxFollowable
      ? () => navigation.follow(syntax)
      : undefined;
  const label = authoredLabel !== "true" && resolution?.available ? resolution.label : children;
  const unfollowable = Boolean(navigation && syntax && !syntaxFollowable);
  const answer = useLinkAnswer(
    syntax && !unfollowable ? navigation : undefined,
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
 * What the cache says about one href, read per reference. Asking is the
 * surface's single requester's job (`watch`), the way the Editor's decoration
 * plugin asks for the whole document in one pass: a reference only registers
 * that it is shown.
 */
function useLinkAnswer(
  navigation: TranscriptLinkNavigation | undefined,
  href: string | null,
): LinkResolutionEntry | null {
  const resolution = navigation?.resolution ?? null;
  const watch = navigation?.watch;
  const subscribe = useCallback(
    (listener: () => void) => resolution?.subscribe(listener) ?? (() => {}),
    [resolution],
  );
  const entry = useSyncExternalStore(
    subscribe,
    () => (resolution && href ? resolution.read(href) : null),
    () => null,
  );
  useEffect(() => (watch && href ? watch(href) : undefined), [watch, href]);
  return entry;
}
