/**
 * Readable transcript references, drawn as link chips; exact identity enables
 * navigation, never syntax alone.
 *
 * An exact `@` reference knows its document or folder: its chip's family is
 * its URI's (or a folder's), and it is dashed once that is gone. A syntax link
 * (a Markdown link to a Context URI) learns its state from the surface's own
 * resolution cache, the one its follows go through, so what it draws and what
 * a click finds agree. Any chip that names a folder opens the menu inside the
 * folder, wherever the folder is now. `[[name]]` is text, never a link.
 */
import { t } from "@lingui/core/macro";
import { qualifyWrittenHref } from "@meridian/markup/links";
import {
  createContext,
  type ReactNode,
  type Ref,
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
  type LinkAnswerCache,
  type LinkRequester,
  type LinkResolutionEntry,
  type LinkTarget,
  linkChip,
  linkChipAttributes,
  linkTargetHref,
  referenceChip,
} from "@/core/editor/links";
import { FolderMenu, useFolderMenuHost } from "@/features/project/context/FolderMenu";

/**
 * How the hosting surface follows a link written as syntax (a Context URI or
 * a relative path) rather than an exact submitted reference.
 * `canFollow` depends only on the target and the surface's base URI, never on
 * loading, so a reference does not flicker between a link and text.
 */
export type TranscriptLinkNavigation = {
  follow(target: LinkTarget): void;
  canFollow(target: LinkTarget): boolean;
  /** The cache the surface's follows resolve through; what a syntax link draws. */
  resolution: LinkAnswerCache | null;
  /** Ask about an href while it is shown; one batched requester per surface. */
  watch: LinkRequester["watch"];
};

export const TranscriptLinkNavigationContext = createContext<TranscriptLinkNavigation | undefined>(
  undefined,
);

/**
 * What the host knows about an exact reference's document or folder, keyed by
 * `referenceKey`. Available carries where it lives now; a gone one has
 * nowhere, so it matches on identity alone and draws dashed.
 */
export type TranscriptReferenceResolution = { kind: "document" | "folder"; id: string } & (
  | { available: true; uri: string; label: string }
  | { available: false }
);

/** An exact reference's identity as resolutions are keyed: kind and id, never confused. */
export function referenceKey(kind: "document" | "folder", id: string): string {
  return `${kind}:${id}`;
}
export const TranscriptReferenceContext = createContext<{
  resolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpen?: (documentId: string) => void;
  canOpen?: (uri: string) => boolean;
  /**
   * The transcript's own chat handle. A message sent from a New chat names an upload bare until
   * the server names the chat and rewrites the stored text; the referenced href is qualified here
   * to the spelling the server's answer uses.
   */
  uploadsChat?: string;
}>({});

export function TranscriptReference({
  children,
  "data-document-id": documentId,
  "data-folder-id": folderId,
  "data-uri": uri,
  "data-target-href": targetHref,
  "data-authored-label": authoredLabel,
}: {
  children?: ReactNode;
  "data-document-id"?: string;
  "data-folder-id"?: string;
  "data-uri"?: string;
  "data-target-href"?: string;
  "data-authored-label"?: string;
}) {
  const { resolutions, onOpen, canOpen, uploadsChat } = useContext(TranscriptReferenceContext);
  const navigation = useContext(TranscriptLinkNavigationContext);
  const folderHost = useFolderMenuHost();
  const target = targetHref ? classifyLinkTarget(targetHref) : null;
  const trigger = useRef<HTMLElement>(null);
  const exact = documentId
    ? { kind: "document" as const, id: documentId }
    : folderId
      ? { kind: "folder" as const, id: folderId }
      : null;
  const candidate = exact ? resolutions?.get(referenceKey(exact.kind, exact.id)) : null;
  // A document's available answer counts only at the URI the writer referenced:
  // one that has moved since is not settled for this occurrence, so it stays
  // filled and does not follow from here. A folder follows its identity: its
  // menu opens wherever the folder is now, while the sent text stays as sent.
  const resolution =
    candidate &&
    exact &&
    candidate.kind === exact.kind &&
    candidate.id === exact.id &&
    (exact.kind === "folder" ||
      !candidate.available ||
      candidate.uri === (uri && qualifyWrittenHref(uri, uploadsChat)))
      ? candidate
      : null;
  const syntax = !exact && target ? target : null;
  const syntaxFollowable = Boolean(syntax && navigation?.canFollow(syntax));
  const unfollowable = Boolean(navigation && syntax && !syntaxFollowable);
  const answer = useLinkAnswer(
    syntax && !unfollowable ? navigation : undefined,
    syntax ? linkTargetHref(syntax) : null,
  );
  // The dashed outline says "nothing reachable" to the eye; `missing` says
  // which to a screen reader, in the words the Editor's hint and the follow
  // use: a reference whose document or folder is gone is no longer available,
  // and a link to an address nothing is at yet does not exist yet. A syntax
  // link has no ref, so it is never gone.
  const gone = Boolean(exact) && resolution?.available === false;
  const menuFolderId =
    exact?.kind === "folder"
      ? exact.id
      : answer?.state === "folder"
        ? answer.folder.folderId
        : null;
  const folderMenu = menuFolderId && folderHost && !gone ? menuFolderId : null;
  const follow =
    exact?.kind === "document"
      ? resolution?.available && onOpen && (canOpen?.(resolution.uri) ?? true)
        ? () => onOpen(resolution.id)
        : undefined
      : navigation && syntax && syntaxFollowable && !folderMenu
        ? () => navigation.follow(syntax)
        : undefined;
  const label = authoredLabel !== "true" && resolution?.available ? resolution.label : children;
  // A syntax link this surface can never follow (a relative path with nothing
  // to be relative to) is text. A link control that can never work is a dead
  // control; the href stays reachable as a tooltip.
  if (unfollowable) return <span title={targetHref}>{label}</span>;
  const chip = exact
    ? referenceChip({ kind: exact.kind, uri: uri ?? "" }, resolution?.available ?? true)
    : syntax && linkChip(syntax, answer);
  const missing =
    chip?.state === "draft"
      ? t`In a draft`
      : chip?.state !== "dashed"
        ? undefined
        : gone
          ? t`No longer available`
          : t`Doesn't exist yet`;
  const element = folderMenu ? (
    <button
      ref={trigger as Ref<HTMLButtonElement>}
      type="button"
      aria-haspopup="menu"
      {...(chip ? linkChipAttributes(chip) : {})}
    >
      {label}
    </button>
  ) : (
    // biome-ignore lint/a11y/useSemanticElements: Internal document references have no browser URL.
    <span
      ref={trigger as Ref<HTMLSpanElement>}
      role="link"
      tabIndex={0}
      aria-disabled={!follow && !folderMenu}
      aria-description={missing}
      title={chip?.state === "draft" ? missing : undefined}
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
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {folderMenu && folderHost ? (
          <FolderMenu host={folderHost} folderId={folderMenu}>
            {element}
          </FolderMenu>
        ) : (
          element
        )}
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
  // A transcript link is Markdown syntax: it carries no ref.
  const entry = useSyncExternalStore(
    subscribe,
    () => (resolution && href ? resolution.read({ ref: null, href }) : null),
    () => null,
  );
  useEffect(() => (watch && href ? watch({ ref: null, href }) : undefined), [watch, href]);
  return entry;
}
