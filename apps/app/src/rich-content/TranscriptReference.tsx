import { t } from "@lingui/core/macro";
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
  MIDDLE_BUTTON,
  referenceChip,
} from "@/core/editor/links";
import { useReferenceDrag } from "@/features/project/context/entry-drag/reference-source";
import { FolderMenu, useFolderMenuHost } from "@/features/project/context/FolderMenu";

export type TranscriptLinkNavigation = {
  follow(target: LinkTarget): void;
  canFollow(target: LinkTarget): boolean;
  resolution: LinkAnswerCache | null;
  watch: LinkRequester["watch"];
};

export const TranscriptLinkNavigationContext = createContext<TranscriptLinkNavigation | undefined>(
  undefined,
);

export type TranscriptReferenceResolution = { kind: "document" | "folder"; id: string } & (
  | { available: true; uri: string; label: string }
  | { available: false }
);

export function referenceKey(kind: "document" | "folder", id: string): string {
  return `${kind}:${id}`;
}
export const TranscriptReferenceContext = createContext<{
  resolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpen?: (documentId: string) => void;
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
  const { resolutions, onOpen } = useContext(TranscriptReferenceContext);
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
  const resolution =
    candidate && exact && candidate.kind === exact.kind && candidate.id === exact.id
      ? candidate
      : null;
  const syntax = !exact && target ? target : null;
  const syntaxFollowable = Boolean(syntax && navigation?.canFollow(syntax));
  const unfollowable = Boolean(navigation && syntax && !syntaxFollowable);
  const answer = useLinkAnswer(
    syntax && !unfollowable ? navigation : undefined,
    syntax ? linkTargetHref(syntax) : null,
  );
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
      ? resolution?.available && onOpen
        ? () => onOpen(resolution.id)
        : undefined
      : navigation && syntax && syntaxFollowable && !folderMenu
        ? () => navigation.follow(syntax)
        : undefined;
  const label = authoredLabel !== "true" && resolution?.available ? resolution.label : children;
  const drag = useReferenceDrag(
    exact && resolution?.available
      ? {
          ref: { kind: exact.kind === "document" ? "file" : "folder", id: exact.id },
          name: resolution.label,
        }
      : null,
  );
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
      {...drag}
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
      {...drag}
      onClick={() => follow?.()}
      onAuxClick={(event) => {
        if (event.button === MIDDLE_BUTTON) follow?.();
      }}
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
          <ContextMenuLabel className="max-w-80 break-all pt-0">
            {uri ?? targetHref}
          </ContextMenuLabel>
        ) : null}
        {follow ? (
          <ContextMenuItem onSelect={() => follow()}>{t`Open link`}</ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
    () => (resolution && href ? resolution.read({ ref: null, href }) : null),
    () => null,
  );
  useEffect(() => (watch && href ? watch({ ref: null, href }) : undefined), [watch, href]);
  return entry;
}
